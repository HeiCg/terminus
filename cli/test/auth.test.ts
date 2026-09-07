import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../src/config.js';
import { CliError } from '../src/errors.js';
import { writeAdminTokenFile } from '../../collector/src/security/adminToken.js';
import { createCollectorHarness } from '../../collector/test/fixtures/harness.js';
import { runCli } from './helpers.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-cli-auth-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('token resolution precedence', () => {
  it('prefers --token over TERMINUS_TOKEN and the file', () => {
    writeAdminTokenFile('file-tok', dir);
    const cfg = resolveConfig({ flags: { token: 'flag-tok' }, env: { TERMINUS_TOKEN: 'env-tok' }, stateDir: dir });
    expect(cfg.token).toBe('flag-tok');
  });

  it('uses TERMINUS_TOKEN when no --token', () => {
    writeAdminTokenFile('file-tok', dir);
    const cfg = resolveConfig({ flags: {}, env: { TERMINUS_TOKEN: 'env-tok' }, stateDir: dir });
    expect(cfg.token).toBe('env-tok');
  });

  it('falls back to the admin-token file when no flag or env', () => {
    writeAdminTokenFile('file-tok', dir);
    const cfg = resolveConfig({ flags: {}, env: {}, stateDir: dir });
    expect(cfg.token).toBe('file-tok');
  });

  it('errors with exit code 2 and a clear message when no token anywhere', () => {
    try {
      resolveConfig({ flags: {}, env: {}, stateDir: dir }); // empty dir, no file
      throw new Error('expected resolveConfig to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(2);
      expect((e as CliError).message).toContain('no token');
    }
  });
});

describe('connection resolution', () => {
  it('defaults to 127.0.0.1:8787', () => {
    const cfg = resolveConfig({ flags: { token: 't' }, env: {} });
    expect(cfg.baseUrl).toBe('http://127.0.0.1:8787');
    expect(cfg.origin).toBe('http://127.0.0.1:8787');
  });

  it('honours --host/--port and TERMINUS_HOST/PORT', () => {
    const byFlag = resolveConfig({ flags: { token: 't', host: '127.0.0.1', port: '9999' }, env: {} });
    expect(byFlag.baseUrl).toBe('http://127.0.0.1:9999');
    const byEnv = resolveConfig({ flags: { token: 't' }, env: { TERMINUS_HOST: 'localhost', TERMINUS_PORT: '9000' } });
    expect(byEnv.baseUrl).toBe('http://localhost:9000');
  });

  it('rejects an invalid port with exit code 1', () => {
    try {
      resolveConfig({ flags: { token: 't', port: 'abc' }, env: {} });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as CliError).code).toBe(1);
    }
  });

  it('in filter mode ignores --host for the connection (it is the traffic filter)', () => {
    const cfg = resolveConfig({ flags: { token: 't', host: 'example.com' }, env: { TERMINUS_HOST: '127.0.0.1' }, hostIsFilter: true });
    expect(cfg.host).toBe('127.0.0.1');
  });
});

describe('auth end to end', () => {
  it('authenticates a command using the admin-token file', async () => {
    const h = await createCollectorHarness();
    try {
      writeAdminTokenFile(h.adminToken, dir);
      const r = await runCli(['devices'], { harness: h, noToken: true, stateDir: dir });
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('reports an auth failure (exit 2) for a bad token', async () => {
    const h = await createCollectorHarness();
    try {
      const r = await runCli(['devices', '--token', 'wrong-token'], { harness: h, noToken: true });
      expect(r.code).toBe(2);
      expect(r.stderr.toLowerCase()).toContain('authentication');
    } finally {
      await h.close();
    }
  });

  it('reports collector unreachable (exit 3) with a hint', async () => {
    // Nothing listening on this port.
    const r = await runCli(['devices'], { env: { TERMINUS_HOST: '127.0.0.1', TERMINUS_PORT: '1', TERMINUS_TOKEN: 't' } });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('is the collector running?');
  });
});
