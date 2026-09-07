import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { Store } from '../../src/store.js';
import { createIdentity } from '../../src/security/identity.js';
import { createDeviceServer } from '../../src/deviceServer.js';
import type { CollectorIdentity } from '../../src/security/types.js';

export type IngestOpts = {
  certificate?: 'paired' | 'other' | 'expired'; // which cert the client pins as its CA
  token?: 'valid' | 'wrong';
  server?: 'paired' | 'expired';                // which identity the server presents
  servername?: string;                          // TLS SNI; defaults to 'localhost'
};
export type IngestResult = { ready: boolean; status?: number; entry?: boolean; error?: string; readyMessage?: unknown };

export interface TlsFixture {
  store: Store;
  pairedDeviceToken: string;
  tryIngest(opts: IngestOpts): Promise<IngestResult>;
  readAdminRoute(path: string): Promise<number>;
  plaintextProducesEntry(): Promise<boolean>;
  close(): Promise<void>;
}

// Build a device-token-shaped value that is NOT the real token.
const wrongToken = () => randomBytes(32).toString('base64url');

// Minimal CollectorIdentity for a TLS server; the device server only needs the cert,
// key, token and id. Used for the expired variant where we bypass buildIdentity.
function fakeIdentity(certPem: string, keyPem: string, deviceToken: string): CollectorIdentity {
  return {
    collectorId: randomUUID(), host: 'localhost', generation: 1,
    certificatePem: certPem, privateKeyPem: keyPem, certificateDerBase64: '', certificateSha256: '',
    deviceToken, notBefore: 0, notAfter: 0, ingestPort: 0, atlantisPort: 0,
    publicPairing: { version: 2, collectorId: 'x', host: 'localhost', ingestPort: 0, atlantisPort: 0, certificateDerBase64: '', certificateSha256: '' },
  };
}

async function listen(server: https.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as net.AddressInfo).port;
}

// Spin up a real-TLS ingest fixture with short-lived, loopback-SAN certificates in a
// temp dir. Clients are genuine TLS clients pinning a CA — success never relies on
// rejectUnauthorized:false.
export async function createTlsFixture(): Promise<TlsFixture> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-tls-'));
  const store = new Store();

  // Paired identity + a second, unrelated identity ("other") to mis-pin.
  const paired = await createIdentity(path.join(dir, 'paired'), { host: 'localhost', ips: ['127.0.0.1', '::1'], generation: 1, keyBits: 2048 }, { ingestPort: 8788, atlantisPort: 10909 });
  const other = await createIdentity(path.join(dir, 'other'), { host: 'localhost', ips: ['127.0.0.1', '::1'], generation: 1, keyBits: 2048 }, { ingestPort: 8788, atlantisPort: 10909 });
  // An already-expired cert for the expiry path. Loaded from a committed fixture
  // (localhost/127.0.0.1/::1 SANs, notAfter 2020-01-02) rather than generated: OpenSSL
  // cannot backdate a cert with portable flags, and a static expired PEM lets the real
  // TLS handshake reject it on the wire (clock injection can't reach Node's TLS layer).
  const expiredCertPem = await fsp.readFile(new URL('./expired-cert.pem', import.meta.url), 'utf8');
  const expiredKeyPem = await fsp.readFile(new URL('./expired-key.pem', import.meta.url), 'utf8');
  const expired = fakeIdentity(expiredCertPem, expiredKeyPem, paired.deviceToken);

  const trust: Record<string, string> = { paired: paired.certificatePem, other: other.certificatePem, expired: expired.certificatePem };

  const pairedServer = createDeviceServer(store, paired);
  const pairedPort = await listen(pairedServer.server);

  let expiredServer: ReturnType<typeof createDeviceServer> | null = null;
  let expiredPort = 0;
  const ensureExpired = async () => {
    if (!expiredServer) { expiredServer = createDeviceServer(store, expired); expiredPort = await listen(expiredServer.server); }
    return expiredPort;
  };

  async function tryIngest(opts: IngestOpts): Promise<IngestResult> {
    const serverVariant = opts.server ?? 'paired';
    const port = serverVariant === 'expired' ? await ensureExpired() : pairedPort;
    const ca = trust[opts.certificate ?? 'paired'];
    const token = opts.token === 'wrong' ? wrongToken() : paired.deviceToken;
    const servername = opts.servername ?? 'localhost';
    const deviceId = `dev-${randomUUID()}`;

    return await new Promise<IngestResult>((resolve) => {
      let settled = false;
      const done = (r: IngestResult) => { if (!settled) { settled = true; try { ws.close(); } catch { /* */ } resolve(r); } };
      const ws = new WebSocket(`wss://127.0.0.1:${port}/ingest`, {
        ca: [ca], servername, rejectUnauthorized: true,
        headers: { authorization: `Bearer ${token}` },
      });
      const guard = setTimeout(() => done({ ready: false, error: 'timeout' }), 4000);
      guard.unref?.();
      // Capture the mandated first server frame ({type:'ready',protocolVersion:2}).
      let readyMessage: unknown = null;
      ws.on('message', (data) => { if (readyMessage === null) { try { readyMessage = JSON.parse(data.toString()); } catch { /* non-JSON */ } } });
      ws.on('open', async () => {
        ws.send(JSON.stringify({ type: 'hello', deviceId, platform: 'ios', appVersion: '1', buildProfile: 'dev', dropped: 0, ts: Date.now() }));
        ws.send(JSON.stringify({ type: 'request', id: `${deviceId}-r`, ts: Date.now(), method: 'GET', url: 'https://x/y', headers: {}, body: null, bodySize: 0, source: 'xhr' }));
        // Give the scheduler a moment to apply and the ready frame to arrive.
        await new Promise((r) => setTimeout(r, 120));
        clearTimeout(guard);
        done({ ready: true, status: 101, entry: store.entries(deviceId).length > 0, readyMessage });
      });
      ws.on('unexpected-response', (_req, res) => { clearTimeout(guard); done({ ready: false, status: res.statusCode }); });
      ws.on('error', (e) => { clearTimeout(guard); done({ ready: false, error: (e as Error).message }); });
    });
  }

  // GET an HTTP route on the TLS ingest listener; there is none, so anything returns
  // 404. Confirms UI/API do not exist on the LAN listener.
  async function readAdminRoute(routePath: string): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const req = https.get({ host: '127.0.0.1', port: pairedPort, path: routePath, ca: [paired.certificatePem], servername: 'localhost' }, (res) => {
        res.resume(); resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
    });
  }

  // A plaintext WebSocket against the TLS port must never produce an entry.
  async function plaintextProducesEntry(): Promise<boolean> {
    const deviceId = `plain-${randomUUID()}`;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${pairedPort}/ingest`, { headers: { authorization: `Bearer ${paired.deviceToken}` } });
      const t = setTimeout(() => { try { ws.close(); } catch { /* */ } resolve(); }, 1000);
      t.unref?.();
      ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', deviceId, platform: 'ios', appVersion: '1', buildProfile: 'dev', dropped: 0, ts: Date.now() })); });
      ws.on('error', () => { clearTimeout(t); resolve(); });
      ws.on('close', () => { clearTimeout(t); resolve(); });
    });
    await new Promise((r) => setTimeout(r, 50));
    return store.entries(deviceId).length > 0;
  }

  async function close(): Promise<void> {
    pairedServer.close();
    await new Promise<void>((r) => pairedServer.server.close(() => r()));
    if (expiredServer) { expiredServer.close(); await new Promise<void>((r) => expiredServer!.server.close(() => r())); }
    if (fs.existsSync(dir)) await fsp.rm(dir, { recursive: true, force: true });
  }

  return { store, pairedDeviceToken: paired.deviceToken, tryIngest, readAdminRoute, plaintextProducesEntry, close };
}
