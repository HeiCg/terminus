import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultStateDir } from './stateDir.js';

// The collector writes its per-boot admin bearer to this file in the state dir so a
// CLI running on the same machine can authenticate without the operator copying a
// token. It carries the same secret the login link embeds; anyone who can read the
// state dir can already read the private key, so the file is 0600 and lives beside
// the other 0600 secrets. It is rewritten every boot (the token rotates on restart)
// and removed on a clean shutdown so a stale file never outlives the process.
export const ADMIN_TOKEN_FILE = 'admin-token';

// P3: the read-only reader bearer, for local automation. Same generation, storage
// and lifecycle as the admin token (0600, atomic, per boot, removed on shutdown);
// only the scope the HTTP gate grants it differs.
export const READER_TOKEN_FILE = 'reader-token';

export type TokenFile = typeof ADMIN_TOKEN_FILE | typeof READER_TOKEN_FILE;

// The absolute path of a token file. `defaultStateDir()` resolves
// TERMINUS_STATE_DIR (or the legacy NETCAPTURE_STATE_DIR) exactly as the collector
// boot does, so the CLI and the collector always agree on the location.
export function tokenFilePath(file: TokenFile, stateDir: string = defaultStateDir()): string {
  return path.join(stateDir, file);
}

// Write a token atomically at 0600: create the state dir if needed, write a fresh
// 0600 temp file in the same dir, then rename over the target so a reader never
// sees a half-written token. The temp name carries 8 random bytes and is opened with
// the 'wx' flag (create-exclusive, fail if it exists), so a stale temp left by a
// crashed run never gets silently reused or clobbered — the next call just picks
// another name. The rename replaces any prior target, restoring 0600 even if an older
// build left looser bits (rename moves the fresh inode, mode and all). The token
// rotates each boot, so the overwrite is expected.
export function writeTokenFile(file: TokenFile, token: string, stateDir: string = defaultStateDir()): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const target = tokenFilePath(file, stateDir);
  const tmp = path.join(stateDir, `.${file}.${randomBytes(8).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, token, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, target);
}

// Remove a token file on shutdown. Best-effort and idempotent: a missing file
// (never written, or already removed) is not an error.
export function removeTokenFile(file: TokenFile, stateDir: string = defaultStateDir()): void {
  try {
    fs.rmSync(tokenFilePath(file, stateDir));
  } catch {
    /* already gone — nothing to clean up */
  }
}

// Read a token a running collector wrote, or null when the file is absent (no
// collector on this machine) or unreadable. Trailing whitespace is trimmed so a
// token pasted or written with a newline still authenticates.
export function readTokenFile(file: TokenFile, stateDir: string = defaultStateDir()): string | null {
  try {
    const raw = fs.readFileSync(tokenFilePath(file, stateDir), 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export const adminTokenPath = (stateDir?: string): string => tokenFilePath(ADMIN_TOKEN_FILE, stateDir);
export const writeAdminTokenFile = (token: string, stateDir?: string): void => writeTokenFile(ADMIN_TOKEN_FILE, token, stateDir);
export const removeAdminTokenFile = (stateDir?: string): void => removeTokenFile(ADMIN_TOKEN_FILE, stateDir);
export const readAdminTokenFile = (stateDir?: string): string | null => readTokenFile(ADMIN_TOKEN_FILE, stateDir);

export const readerTokenPath = (stateDir?: string): string => tokenFilePath(READER_TOKEN_FILE, stateDir);
export const writeReaderTokenFile = (token: string, stateDir?: string): void => writeTokenFile(READER_TOKEN_FILE, token, stateDir);
export const removeReaderTokenFile = (stateDir?: string): void => removeTokenFile(READER_TOKEN_FILE, stateDir);
