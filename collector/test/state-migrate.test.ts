import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyStateDir } from '../src/security/identity.js';

// The migration renames a whole pre-Terminus state dir in one move so paired
// devices survive the rename. These tests drive it entirely through temp dirs
// (an injected legacyDir + a temp newDir) — never the real Application Support.
describe('migrateLegacyStateDir', () => {
  let base: string;
  let legacy: string;
  let next: string;
  const savedTerminus = process.env.TERMINUS_STATE_DIR;
  const savedNetcapture = process.env.NETCAPTURE_STATE_DIR;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-migrate-'));
    legacy = path.join(base, 'ArgoNetCapture');
    next = path.join(base, 'Terminus');
    delete process.env.TERMINUS_STATE_DIR;
    delete process.env.NETCAPTURE_STATE_DIR;
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
    if (savedTerminus === undefined) delete process.env.TERMINUS_STATE_DIR; else process.env.TERMINUS_STATE_DIR = savedTerminus;
    if (savedNetcapture === undefined) delete process.env.NETCAPTURE_STATE_DIR; else process.env.NETCAPTURE_STATE_DIR = savedNetcapture;
  });

  it('is a no-op on non-macOS platforms (argo-netcapture was macOS only)', async () => {
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'device-token'), 'tok');

    await migrateLegacyStateDir(next, legacy, 'linux');
    await migrateLegacyStateDir(next, legacy, 'win32');

    // The legacy dir is left untouched and nothing is created at the new location.
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(next)).toBe(false);
  });

  it('renames the legacy dir to the new one, carrying its contents', async () => {
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'device-token'), 'tok');
    fs.writeFileSync(path.join(legacy, 'identity.json'), '{"generation":1}');

    await migrateLegacyStateDir(next, legacy, 'darwin');

    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(next, 'device-token'), 'utf8')).toBe('tok');
    expect(fs.readFileSync(path.join(next, 'identity.json'), 'utf8')).toBe('{"generation":1}');
  });

  it('does nothing when a populated new dir already exists (identity.json present)', async () => {
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'device-token'), 'old');
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(path.join(next, 'identity.json'), '{"generation":2}');
    fs.writeFileSync(path.join(next, 'device-token'), 'new');

    await migrateLegacyStateDir(next, legacy, 'darwin');

    // Neither dir is touched: the live Terminus identity wins, the legacy one stays.
    expect(fs.readFileSync(path.join(legacy, 'device-token'), 'utf8')).toBe('old');
    expect(fs.readFileSync(path.join(next, 'device-token'), 'utf8')).toBe('new');
  });

  it('migrates when the new dir exists but is empty', async () => {
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'identity.json'), '{"generation":1}');
    fs.writeFileSync(path.join(legacy, 'device-token'), 'tok');
    fs.mkdirSync(next, { recursive: true }); // empty leftover from a partial run

    await migrateLegacyStateDir(next, legacy, 'darwin');

    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(next, 'device-token'), 'utf8')).toBe('tok');
  });

  it('warns and does not throw when rename fails cross-device (EXDEV)', async () => {
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'identity.json'), '{"generation":1}');
    fs.writeFileSync(path.join(legacy, 'device-token'), 'tok');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const renameSpy = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
    );

    // Never throws out of migration; the collector continues with a fresh state dir.
    await expect(migrateLegacyStateDir(next, legacy, 'darwin')).resolves.toBeUndefined();

    const warned = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warned).toContain(legacy);
    expect(warned).toContain('EXDEV');
    // The rename was attempted; the legacy dir is left in place for a manual move.
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(next)).toBe(false);

    renameSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('does nothing when the state dir is overridden explicitly', async () => {
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'device-token'), 'tok');
    process.env.TERMINUS_STATE_DIR = next;

    await migrateLegacyStateDir(next, legacy, 'darwin');

    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(next)).toBe(false);
  });

  it('does nothing when there is no legacy dir', async () => {
    await migrateLegacyStateDir(next, legacy, 'darwin');
    expect(fs.existsSync(next)).toBe(false);
  });
});
