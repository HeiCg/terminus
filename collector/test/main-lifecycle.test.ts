import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminTokenPath, readerTokenPath } from '../src/security/adminToken.js';

const collectorDir = fileURLToPath(new URL('..', import.meta.url));

// A free loopback port, grabbed and released. The collector only binds fixed ports
// when the env does not override them, so overriding every port here keeps this test
// off the live collector's 8787/8788/8789/10909.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function tsxBin(): string {
  const candidate = path.resolve(collectorDir, '..', 'node_modules', '.bin', 'tsx');
  return fs.existsSync(candidate) ? candidate : 'tsx';
}

describe('collector shutdown lifecycle', () => {
  it('removes the admin-token file on SIGTERM and exits', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-lifecycle-'));
    const [PORT, INGEST_PORT, ATLANTIS_PORT, CERT_PORT] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
    const child = spawn(tsxBin(), ['src/main.ts'], {
      cwd: collectorDir,
      env: {
        ...process.env,
        PORT: String(PORT), INGEST_PORT: String(INGEST_PORT), ATLANTIS_PORT: String(ATLANTIS_PORT),
        TERMINUS_CERT_PORT: String(CERT_PORT), TERMINUS_STATE_DIR: stateDir,
      },
      stdio: 'ignore',
    });
    const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
    const tokenPath = adminTokenPath(stateDir);
    try {
      // Wait for boot to publish the admin-token file (identity generation runs first).
      const start = Date.now();
      while (!fs.existsSync(tokenPath)) {
        if (Date.now() - start > 25_000) throw new Error('collector never wrote the admin-token file');
        if (child.exitCode != null) throw new Error(`collector exited early (${child.exitCode})`);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(fs.existsSync(tokenPath)).toBe(true);

      child.kill('SIGTERM');
      await exited;
      expect(fs.existsSync(tokenPath)).toBe(false);
    } finally {
      if (child.exitCode == null) child.kill('SIGKILL');
      await exited.catch(() => undefined);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }, 30_000);

  // P3: the reader token rides the same lifecycle as the admin token.
  it('writes a 0600 reader-token distinct from the admin token, removes it on SIGTERM, and rotates it per boot', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-lifecycle-reader-'));
    const boot = async () => {
      const [PORT, INGEST_PORT, ATLANTIS_PORT, CERT_PORT] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
      const child = spawn(tsxBin(), ['src/main.ts'], {
        cwd: collectorDir,
        env: {
          ...process.env,
          PORT: String(PORT), INGEST_PORT: String(INGEST_PORT), ATLANTIS_PORT: String(ATLANTIS_PORT),
          TERMINUS_CERT_PORT: String(CERT_PORT), TERMINUS_STATE_DIR: stateDir,
        },
        stdio: 'ignore',
      });
      const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
      return { child, exited, port: PORT };
    };
    const waitFor = async (child: ReturnType<typeof spawn>, pred: () => boolean | Promise<boolean>, what: string) => {
      const start = Date.now();
      while (!(await pred())) {
        if (Date.now() - start > 25_000) throw new Error(`timed out waiting for ${what}`);
        if (child.exitCode != null) throw new Error(`collector exited early (${child.exitCode})`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const adminPath = adminTokenPath(stateDir);
    const readerPath = readerTokenPath(stateDir);
    const runs: Awaited<ReturnType<typeof boot>>[] = [];
    try {
      const first = await boot(); runs.push(first);
      await waitFor(first.child, () => fs.existsSync(adminPath) && fs.existsSync(readerPath), 'the token files');
      const admin = fs.readFileSync(adminPath, 'utf8');
      const reader1 = fs.readFileSync(readerPath, 'utf8');
      expect(reader1).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
      expect(reader1).not.toBe(admin);
      if (process.platform !== 'win32') expect(fs.statSync(readerPath).mode & 0o777).toBe(0o600);

      // The live collector accepts it, with the reader scope.
      const base = `http://127.0.0.1:${first.port}`;
      await waitFor(first.child, () => fetch(base + '/health').then((r) => r.ok, () => false), 'the HTTP listener');
      const auth = { authorization: `Bearer ${reader1}` };
      expect((await fetch(base + '/api/status', { headers: auth })).status).toBe(200);
      expect((await fetch(base + '/api/clear', { method: 'POST', headers: auth })).status).toBe(403);

      first.child.kill('SIGTERM');
      await first.exited;
      expect(fs.existsSync(readerPath)).toBe(false);
      expect(fs.existsSync(adminPath)).toBe(false);

      const second = await boot(); runs.push(second);
      await waitFor(second.child, () => fs.existsSync(readerPath), 'the reader-token file');
      expect(fs.readFileSync(readerPath, 'utf8')).not.toBe(reader1);
      second.child.kill('SIGTERM');
      await second.exited;
      expect(fs.existsSync(readerPath)).toBe(false);
    } finally {
      for (const r of runs) {
        if (r.child.exitCode == null) r.child.kill('SIGKILL');
        await r.exited.catch(() => undefined);
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60_000);
});
