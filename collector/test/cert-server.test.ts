import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createCertServer } from '../src/security/certServer.js';
import type { CollectorIdentity } from '../src/security/types.js';

// A real DER SEQUENCE (0x30 tag) and its true SHA-256, so the app's later check —
// sha256(base64decode(certificateDerBase64)) === certificateSha256 — can be proven
// against what the listener serves.
const DER = Buffer.from([0x30, 0x08, 0x02, 0x01, 0x2a, 0x02, 0x03, 0x00, 0xff, 0x01]);
const DER_B64 = DER.toString('base64');
const DER_SHA256 = createHash('sha256').update(DER).digest('hex');
const DEVICE_TOKEN = Buffer.alloc(32, 7).toString('base64url');

function identity(): CollectorIdentity {
  // Only collectorId/certificateDerBase64/certificateSha256 are read; the rest is
  // filled so the object is a structurally complete identity (and carries a
  // deviceToken the response must never leak).
  return {
    collectorId: '6f1c2b0e-3b7a-4c1d-9e2f-0a1b2c3d4e5f',
    host: '192.168.0.10',
    generation: 1,
    certificatePem: '',
    privateKeyPem: '',
    certificateDerBase64: DER_B64,
    certificateSha256: DER_SHA256,
    deviceToken: DEVICE_TOKEN,
    notBefore: 0,
    notAfter: 0,
    ingestPort: 8788,
    atlantisPort: 10909,
    publicPairing: {
      version: 2,
      collectorId: '6f1c2b0e-3b7a-4c1d-9e2f-0a1b2c3d4e5f',
      host: '192.168.0.10',
      ingestPort: 8788,
      atlantisPort: 10909,
      certificateDerBase64: DER_B64,
      certificateSha256: DER_SHA256,
    },
  };
}

let handle: ReturnType<typeof createCertServer> | null = null;
async function start(): Promise<string> {
  handle = createCertServer({ identity: identity(), port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => handle!.listen(() => r()));
  const port = (handle!.server.address() as net.AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}
afterEach(async () => {
  if (handle) { await new Promise<void>((r) => handle!.server.close(() => r())); handle = null; }
});

// Raw request so a test can forge the method and Host header.
const raw = (url: string, method: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });

describe('createCertServer (F2, dedicated LAN listener)', () => {
  it('serves the cert on GET /api/cert unauthenticated, sha256 matching the DER', async () => {
    const url = await start();
    const res = await raw(url + '/api/cert', 'GET');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['connection']).toBe('close');
    const body = JSON.parse(res.body);
    expect(body.collectorId).toBe('6f1c2b0e-3b7a-4c1d-9e2f-0a1b2c3d4e5f');
    expect(body.certificateDerBase64).toBe(DER_B64);
    expect(body.certificateSha256).toBe(DER_SHA256);
    const computed = createHash('sha256').update(Buffer.from(body.certificateDerBase64, 'base64')).digest('hex');
    expect(computed).toBe(body.certificateSha256);
  });

  it('answers HEAD /api/cert with 200 and no body', async () => {
    const url = await start();
    const res = await raw(url + '/api/cert', 'HEAD');
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('never leaks the deviceToken', async () => {
    const url = await start();
    const res = await raw(url + '/api/cert', 'GET');
    expect(res.body).not.toContain(DEVICE_TOKEN);
    expect(res.body).not.toContain('deviceToken');
  });

  it('404s any other path', async () => {
    const url = await start();
    expect((await raw(url + '/', 'GET')).status).toBe(404);
    expect((await raw(url + '/api/pairing', 'GET')).status).toBe(404);
    expect((await raw(url + '/health', 'GET')).status).toBe(404);
  });

  it('405s a non-GET/HEAD method', async () => {
    const url = await start();
    expect((await raw(url + '/api/cert', 'POST')).status).toBe(405);
    expect((await raw(url + '/api/cert', 'PUT')).status).toBe(405);
  });

  it('does NOT apply a Host check (public data, dialed by LAN IP)', async () => {
    const url = await start();
    // A foreign Host would be 421 on the loopback UI server; here it is served.
    const res = await raw(url + '/api/cert', 'GET', { host: 'anything.test' });
    expect(res.status).toBe(200);
  });

  it('configures connection limits and header/request timeouts (slowloris guards)', () => {
    // No listen needed — the caps are set at construction on the http.Server.
    const h = createCertServer({ identity: identity(), port: 0 });
    expect(h.server.maxConnections).toBe(32);
    expect(h.server.headersTimeout).toBe(5000);
    expect(h.server.requestTimeout).toBe(5000);
  });
});
