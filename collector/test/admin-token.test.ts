import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ADMIN_TOKEN_FILE,
  adminTokenPath,
  writeAdminTokenFile,
  removeAdminTokenFile,
  readAdminTokenFile,
} from '../src/security/adminToken.js';

// A throwaway state dir per test so nothing touches the operator's real
// ~/Library/Application Support/Terminus.
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-admintoken-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('admin-token file', () => {
  it('writes the token 0600 at <stateDir>/admin-token', () => {
    writeAdminTokenFile('secret-abc', dir);
    const p = adminTokenPath(dir);
    expect(p).toBe(path.join(dir, ADMIN_TOKEN_FILE));
    expect(fs.readFileSync(p, 'utf8')).toBe('secret-abc');
    // 0600 (owner rw only). Mask to the permission bits; skip on platforms that
    // do not honour POSIX modes (Windows), where the low bits are meaningless.
    if (process.platform !== 'win32') {
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  it('creates the state dir if it does not exist', () => {
    const nested = path.join(dir, 'a', 'b', 'Terminus');
    writeAdminTokenFile('t', nested);
    expect(fs.readFileSync(adminTokenPath(nested), 'utf8')).toBe('t');
  });

  it('overwrites a prior token (rotation on reboot) and keeps 0600', () => {
    writeAdminTokenFile('old-token', dir);
    // Loosen the bits as an older build might have; the rewrite must restore 0600.
    if (process.platform !== 'win32') fs.chmodSync(adminTokenPath(dir), 0o644);
    writeAdminTokenFile('new-token', dir);
    expect(readAdminTokenFile(dir)).toBe('new-token');
    if (process.platform !== 'win32') {
      expect(fs.statSync(adminTokenPath(dir)).mode & 0o777).toBe(0o600);
    }
  });

  it('succeeds despite a stale temp file left by a crashed run (random name + wx)', () => {
    // A leftover temp from a prior crash must not block or get reused: the write
    // picks a fresh random name and 'wx' refuses to clobber anything.
    fs.writeFileSync(path.join(dir, `.${ADMIN_TOKEN_FILE}.deadbeefdeadbeef.tmp`), 'garbage');
    writeAdminTokenFile('fresh-token', dir);
    expect(readAdminTokenFile(dir)).toBe('fresh-token');
    if (process.platform !== 'win32') {
      expect(fs.statSync(adminTokenPath(dir)).mode & 0o777).toBe(0o600);
    }
    // The write leaves no temp of its own behind (it renamed into place).
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([`.${ADMIN_TOKEN_FILE}.deadbeefdeadbeef.tmp`]); // only the pre-existing stale one
  });

  it('reads back the token, trimming trailing whitespace', () => {
    fs.writeFileSync(adminTokenPath(dir), 'padded-token\n');
    expect(readAdminTokenFile(dir)).toBe('padded-token');
  });

  it('reads null when the file is absent or empty', () => {
    expect(readAdminTokenFile(dir)).toBeNull();
    fs.writeFileSync(adminTokenPath(dir), '   \n');
    expect(readAdminTokenFile(dir)).toBeNull();
  });

  it('removes the file on shutdown and is idempotent', () => {
    writeAdminTokenFile('x', dir);
    expect(fs.existsSync(adminTokenPath(dir))).toBe(true);
    removeAdminTokenFile(dir);
    expect(fs.existsSync(adminTokenPath(dir))).toBe(false);
    // A second removal (or one that never ran) must not throw.
    expect(() => removeAdminTokenFile(dir)).not.toThrow();
  });
});
