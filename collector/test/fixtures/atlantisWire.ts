import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import type { Store } from '../../src/store.js';
import { startAtlantisServer, applyAtlantisEvent } from '../../src/atlantis/server.js';
import { decodeAtlantis } from '../../src/atlantis/decode.js';
import { createIngestShared, type IngestShared } from '../../src/deviceServer.js';
import { createIdentity, toPairingImport } from '../../src/security/identity.js';
import { FrameAccumulator } from '../../src/atlantis/frames.js';
import type { CollectorIdentity } from '../../src/security/types.js';
import { createCollectorHarness, type CollectorHarness } from './harness.js';

// Atlantis wire helpers in the Terminus fork's format (P2 tests): envelopes,
// ConnectionPackage / traffic / request-start packets, an authenticated TLS client,
// and a collector harness with a live Atlantis listener on the same Store.

const gz = (obj: unknown) => gzipSync(Buffer.from(JSON.stringify(obj)));
const lengthPrefixed = (payload: Buffer) => { const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(payload.length)); return Buffer.concat([h, payload]); };
export const envelopePayload = (id: string, messageType: string, inner: unknown) =>
  gz({ id, messageType, content: Buffer.from(JSON.stringify(inner)).toString('base64'), buildVersion: '1.0' });
export const envelope = (id: string, messageType: string, inner: unknown) => lengthPrefixed(envelopePayload(id, messageType, inner));

export type Conn = { device?: Record<string, unknown>; project?: Record<string, unknown>; passcode?: string };
export const connectionInner = (c: Conn) => ({ device: { name: 'Pixel', model: 'sdk_gphone64 (Android 14)' }, project: { name: 'Acme', bundleIdentifier: 'com.acme.app' }, ...c });
const b64 = (s: string) => Buffer.from(s).toString('base64');
export const completedInner = (tid: string, over: Record<string, unknown> = {}) => ({
  id: tid, startAt: 10, endAt: 10.25, packageType: 'http',
  request: { url: `https://api.example/${tid}`, method: 'POST', headers: [], body: b64('req') },
  response: { statusCode: 200, headers: [{ key: 'Content-Type', value: 'application/json' }] }, responseBodyData: b64('{"ok":true}'), error: null, ...over,
});
// The fork's request-start packet: no response, no endAt, no error.
export const startInner = (tid: string) => ({ id: tid, startAt: 10, request: { url: `https://api.example/${tid}`, method: 'POST', headers: [], body: b64('req') }, responseBodyData: '', packageType: 'http' });

// Decode and apply one envelope straight into a store (no socket).
export function apply(store: Store, id: string, messageType: string, inner: unknown): void {
  const ev = decodeAtlantis(envelopePayload(id, messageType, inner));
  if (!ev) throw new Error('undecodable test frame');
  applyAtlantisEvent(store, ev, 'gen-1');
}

// A real collector identity whose SAN covers localhost, 127.0.0.1 and ::1.
export async function createTestIdentity(): Promise<{ identity: CollectorIdentity; dispose: () => Promise<void> }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-ident-'));
  const identity = await createIdentity(dir, { host: 'localhost', ips: ['127.0.0.1', '::1'], generation: 1, keyBits: 2048 }, { ingestPort: 8788, atlantisPort: 10909 });
  return { identity, dispose: () => fsp.rm(dir, { recursive: true, force: true }) };
}

export const until = (fn: () => boolean, ms = 3000) => new Promise<void>((res, rej) => {
  const t0 = Date.now();
  const i = setInterval(() => { if (fn()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')); } }, 10);
});

// An authenticated Atlantis TLS client: resolves once the server sent `ready`.
export async function atlantisClient(identity: CollectorIdentity, port: number, envelopeId: string, conn: Conn = {}): Promise<tls.TLSSocket> {
  const s = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const sock = tls.connect({ host: '127.0.0.1', port, ca: [identity.certificatePem], servername: 'localhost', rejectUnauthorized: true }, () => resolve(sock));
    sock.on('error', reject);
  });
  const acc = new FrameAccumulator();
  const ready = new Promise<void>((resolve) => {
    s.on('data', (chunk: Buffer) => {
      for (const f of acc.push(chunk)) {
        const env = JSON.parse(f.toString('utf8'));
        if (env.messageType === 'control' && JSON.parse(Buffer.from(env.content, 'base64').toString('utf8')).type === 'ready') resolve();
      }
    });
  });
  s.write(envelope(envelopeId, 'connection', connectionInner({ passcode: identity.deviceToken, ...conn })));
  await ready;
  return s;
}

// The HTTP harness plus an Atlantis TLS listener feeding the same Store. `get`
// calls the HTTP API with the admin bearer. The pairing blob advertises 192.168.9.9.
export type AtlantisEnv = { h: CollectorHarness; port: number; shared: IngestShared; client: (envelopeId: string, conn?: Conn) => Promise<tls.TLSSocket>; get: (p: string) => Promise<Response> };
export async function withAtlantisCollector(identity: CollectorIdentity, fn: (e: AtlantisEnv) => Promise<void>): Promise<void> {
  const h = await createCollectorHarness({ getPairing: () => toPairingImport(identity, '192.168.9.9') });
  const shared = createIngestShared();
  const srv = startAtlantisServer(h.store, 0, { identity, host: '127.0.0.1', shared, pingMs: 0 });
  await new Promise<void>((r) => srv.once('listening', r));
  const port = (srv.address() as net.AddressInfo).port;
  const auth = { authorization: `Bearer ${h.adminToken}` };
  try {
    await fn({ h, port, shared, client: (id, conn) => atlantisClient(identity, port, id, conn), get: (p) => fetch(h.url + p, { headers: auth }) });
  } finally { srv.close(); await h.close(); }
}
