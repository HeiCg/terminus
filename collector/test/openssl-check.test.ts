import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureOpenSSL } from '../src/security/identity.js';

// The startup OpenSSL check names a fix for each supported platform (macOS and
// Linux), not only Homebrew. A fake `openssl` on a private PATH drives each case.
let dir: string;
let savedPath: string | undefined;

function fakeOpenssl(versionLine: string): void {
  const bin = path.join(dir, 'openssl');
  fs.writeFileSync(bin, `#!/bin/sh\necho "${versionLine}"\n`, { mode: 0o755 });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-openssl-'));
  savedPath = process.env.PATH;
  process.env.PATH = dir;
});
afterEach(() => {
  process.env.PATH = savedPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ensureOpenSSL', () => {
  it('missing binary: platform-neutral message with a macOS and a Linux hint', async () => {
    const err = await ensureOpenSSL().then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/^OpenSSL 3 not found on PATH\./);
    expect(err?.message).toContain('macOS');
    expect(err?.message).toContain('brew install openssl@3');
    expect(err?.message).toContain('Linux');
    expect(err?.message).toContain('apt install openssl');
  });

  it('too old (or LibreSSL): names what was found and gives the same hints', async () => {
    fakeOpenssl('LibreSSL 3.3.6');
    const err = await ensureOpenSSL().then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/^OpenSSL 3 required, found: LibreSSL 3\.3\.6\./);
    expect(err?.message).toContain('brew install openssl@3');
    expect(err?.message).toContain('Linux');
  });

  it('OpenSSL 3 passes', async () => {
    fakeOpenssl('OpenSSL 3.0.13 30 Jan 2024');
    await expect(ensureOpenSSL()).resolves.toBeUndefined();
  });
});
