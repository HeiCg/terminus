import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAdminTokenFile, writeReaderTokenFile } from '../../collector/src/security/adminToken.js';
import { createCollectorHarness, type CollectorHarness } from '../../collector/test/fixtures/harness.js';
import { runCli, startCli, makeEntry, type RunOptions } from './helpers.js';

// P3: the read-only reader token through the CLI. `status` and `ls` work with it;
// commands that need admin print one clear line instead of a generic auth failure.
const SCOPE_MSG = 'this command needs the admin token (reader token given)';

const asReader = (h: CollectorHarness): RunOptions => ({ harness: h, noToken: true, env: { TERMINUS_TOKEN: h.readerToken } });

describe('reader token in the CLI (P3)', () => {
  it('status works with the reader token (from /api/status, without the admin-only /ui socket)', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.addEntry(makeEntry());
      const r = await runCli(['status'], asReader(h));
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Terminus collector');
      expect(r.stdout).toContain('version');
      expect(r.stdout).toContain('paused');
      expect(r.stdout).toContain('bodies');
      expect(r.stderr).toBe('');

      const json = await runCli(['status', '--json'], asReader(h));
      expect(json.code).toBe(0);
      const merged = JSON.parse(json.stdout);
      expect(merged.snapshot).toBeNull();
      expect(typeof merged.status.version).toBe('string');
    } finally { await h.close(); }
  });

  it('ls works with the reader token via TERMINUS_TOKEN and via --token', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.addEntry(makeEntry({ id: 'r1', url: 'https://api.example.com/reader-visible' }));
      const env = await runCli(['ls'], asReader(h));
      expect(env.code).toBe(0);
      expect(env.stdout).toContain('/reader-visible');
      const flag = await runCli(['ls', '--token', h.readerToken], { harness: h, noToken: true });
      expect(flag.code).toBe(0);
      expect(flag.stdout).toContain('/reader-visible');
    } finally { await h.close(); }
  });

  it('tail with the reader token prints the clear scope message and exits non-zero', async () => {
    const h = await createCollectorHarness();
    try {
      const controller = new AbortController();
      const { done } = startCli(['tail'], { ...asReader(h), signal: controller.signal });
      const r = await done; // a scope refusal is permanent: tail must not reconnect-loop
      expect(r.code).toBe(2);
      expect(r.stderr.trim()).toBe(SCOPE_MSG);
    } finally { await h.close(); }
  });

  it('admin-only HTTP commands (clear, pause, pair, replay) print the scope message and change nothing', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.addEntry(makeEntry({ id: 'keep' }));
      for (const argv of [['clear'], ['pause'], ['pair'], ['replay', 'd1/keep']]) {
        const r = await runCli(argv, asReader(h));
        expect(r.code, argv.join(' ')).toBe(2);
        expect(r.stderr.trim(), argv.join(' ')).toBe(SCOPE_MSG);
      }
      expect(h.store.entries('d1')).toHaveLength(1);
    } finally { await h.close(); }
  });

  it('a wrong token keeps the generic authentication message', async () => {
    const h = await createCollectorHarness();
    try {
      const r = await runCli(['ls'], { harness: h, noToken: true, env: { TERMINUS_TOKEN: 'wrong' } });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('authentication failed');
    } finally { await h.close(); }
  });
});

// Read-only commands fall back to <stateDir>/reader-token when admin-token is absent;
// admin commands keep reading admin-token only.
describe('reader-token file fallback for read-only commands', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-cli-reader-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const fileOnly = (h: CollectorHarness): RunOptions => ({ harness: h, noToken: true, stateDir: dir });

  it('status, ls, devices and show authenticate from a lone reader-token file', async () => {
    const h = await createCollectorHarness();
    try {
      writeReaderTokenFile(h.readerToken, dir);
      h.store.addEntry(makeEntry({ id: 'rf1', url: 'https://api.example.com/from-reader-file' }));
      const status = await runCli(['status'], fileOnly(h));
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain('Terminus collector');
      const ls = await runCli(['ls'], fileOnly(h));
      expect(ls.code, ls.stderr).toBe(0);
      expect(ls.stdout).toContain('/from-reader-file');
      const devices = await runCli(['devices'], fileOnly(h));
      expect(devices.code, devices.stderr).toBe(0);
      const show = await runCli(['show', 'd1/rf1', '--body', 'none'], fileOnly(h));
      expect(show.code, show.stderr).toBe(0);
      expect(show.stdout).toContain('/from-reader-file');
    } finally { await h.close(); }
  });

  it('read-only commands still prefer admin-token when both files exist', async () => {
    const h = await createCollectorHarness();
    try {
      writeAdminTokenFile(h.adminToken, dir);
      writeReaderTokenFile('stale-reader', dir);
      const r = await runCli(['ls'], fileOnly(h));
      expect(r.code, r.stderr).toBe(0);
    } finally { await h.close(); }
  });

  it('admin commands do not fall back to reader-token: they report no token', async () => {
    const h = await createCollectorHarness();
    try {
      writeReaderTokenFile(h.readerToken, dir);
      h.store.addEntry(makeEntry({ id: 'keep' }));
      for (const argv of [['clear'], ['pause'], ['pair'], ['export'], ['tail']]) {
        const r = await runCli(argv, fileOnly(h));
        expect(r.code, argv.join(' ')).toBe(2);
        expect(r.stderr, argv.join(' ')).toContain('no token');
      }
      expect(h.store.entries('d1')).toHaveLength(1);
    } finally { await h.close(); }
  });

  it('TERMINUS_TOKEN still wins over the reader-token file', async () => {
    const h = await createCollectorHarness();
    try {
      writeReaderTokenFile(h.readerToken, dir);
      const r = await runCli(['ls'], { ...fileOnly(h), env: { TERMINUS_TOKEN: 'wrong' } });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('authentication failed');
    } finally { await h.close(); }
  });
});
