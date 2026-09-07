import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminTokenPath } from '../src/security/adminToken.js';

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
});
