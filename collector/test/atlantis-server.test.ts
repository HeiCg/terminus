import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { Store } from '../src/store.js';
import { startAtlantisServer } from '../src/atlantis/server.js';
import { createIdentity } from '../src/security/identity.js';
import { FrameAccumulator } from '../src/atlantis/frames.js';
import type { CollectorIdentity } from '../src/security/types.js';

const frame = (obj: unknown) => {
  const payload = gzipSync(Buffer.from(JSON.stringify(obj)));
  const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(payload.length));
  return Buffer.concat([h, payload]);
};
const envelope = (id: string, messageType: string, inner: unknown) =>
  frame({ id, messageType, content: Buffer.from(JSON.stringify(inner)).toString('base64'), buildVersion: '1.0' });
const connection = (id: string, inner: Record<string, unknown>) =>
  envelope(id, 'connection', { device: { name: 'n', model: 'iPhone15,2' }, project: { name: 'proj', bundleIdentifier: 'b' }, ...inner });
const traffic = (id: string, tid: string) =>
  envelope(id, 'traffic', { id: tid, startAt: 1, endAt: 1.1, packageType: 'http', request: { url: 'https://x/y', method: 'GET', headers: [] }, response: { statusCode: 200, headers: [] }, responseBodyData: null, error: null });

let identity: CollectorIdentity;
let dir: string;
beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-atl-'));
  identity = await createIdentity(dir, { host: 'localhost', ips: ['127.0.0.1', '::1'], generation: 1, keyBits: 2048 }, { ingestPort: 8788, atlantisPort: 10909 });
});
afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

async function withServer<T>(fn: (port: number, store: Store) => Promise<T>): Promise<T> {
  const store = new Store();
  const srv = startAtlantisServer(store, 0, { identity, host: '127.0.0.1' });
  await new Promise<void>((r) => srv.once('listening', r));
  const port = (srv.address() as net.AddressInfo).port;
  try { return await fn(port, store); } finally { srv.close(); }
}
const connectTls = (port: number) => new Promise<tls.TLSSocket>((resolve, reject) => {
  const s = tls.connect({ host: '127.0.0.1', port, ca: [identity.certificatePem], servername: 'localhost', rejectUnauthorized: true }, () => resolve(s));
  s.on('error', reject);
});
const until = (fn: () => boolean, ms = 2000) => new Promise<void>((res, rej) => {
  const t0 = Date.now();
  const i = setInterval(() => { if (fn()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')); } }, 10);
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Read the first control frame (ready / auth_error) the server sends.
function readControl(sock: tls.TLSSocket): Promise<string> {
  const acc = new FrameAccumulator();
  return new Promise((resolve) => {
    sock.on('data', (chunk: Buffer) => {
      let frames: Buffer[]; try { frames = acc.push(chunk); } catch { return; }
      for (const f of frames) {
        try {
          const env = JSON.parse(f.toString('utf8'));
          if (env.messageType === 'control') {
            const ctrl = JSON.parse(Buffer.from(env.content, 'base64').toString('utf8'));
            resolve(ctrl.type);
          }
        } catch { /* not a control frame */ }
      }
    });
  });
}

describe('startAtlantisServer (TLS v2)', () => {
  it('infers android platform from device.model (C2)', () => withServer(async (port, store) => {
    const s = await connectTls(port);
    s.write(connection('dev-a', { passcode: identity.deviceToken, device: { name: 'n', model: 'Google Pixel 7 (Android 14)' } }));
    await until(() => store.devices().length === 1);
    expect(store.devices()[0].platform).toBe('android');
    s.destroy();
  }));
  it('defaults to ios when model has no Android marker (C2)', () => withServer(async (port, store) => {
    const s = await connectTls(port);
    s.write(connection('dev-i', { passcode: identity.deviceToken, device: { name: 'n', model: 'iPhone15,2' } }));
    await until(() => store.devices().length === 1);
    expect(store.devices()[0].platform).toBe('ios');
    s.destroy();
  }));
  it('uses appVersion from the ConnectionPackage when present (C3)', () => withServer(async (port, store) => {
    const s = await connectTls(port);
    s.write(connection('dev-v', { passcode: identity.deviceToken, appVersion: '9.9.9' }));
    await until(() => store.devices().length === 1);
    expect(store.devices()[0].appVersion).toBe('9.9.9');
    s.destroy();
  }));
  it('falls back to project.name when appVersion is absent (C3)', () => withServer(async (port, store) => {
    const s = await connectTls(port);
    s.write(connection('dev-f', { passcode: identity.deviceToken })); // no appVersion
    await until(() => store.devices().length === 1);
    expect(store.devices()[0].appVersion).toBe('proj');
    s.destroy();
  }));

  it('sends a ready control frame then ingests traffic on a valid device token', () => withServer(async (port, store) => {
    const s = await connectTls(port);
    const control = readControl(s);
    s.write(connection('dev-ok', { passcode: identity.deviceToken }));
    expect(await control).toBe('ready');
    s.write(traffic('dev-ok', 'T-ok'));
    await until(() => store.entries('dev-ok').length === 1);
    expect(store.devices()).toHaveLength(1);
    s.destroy();
  }));

  it('sends auth_error and closes on a wrong device token, ingesting nothing', () => withServer(async (port, store) => {
    const s = await connectTls(port);
    const control = readControl(s);
    const closed = new Promise<void>((r) => s.on('close', () => r()));
    s.write(connection('dev-bad', { passcode: 'wrong-token' }));
    s.write(traffic('dev-bad', 'T-bad'));
    expect(await control).toBe('auth_error');
    await closed;
    await sleep(50);
    expect(store.devices()).toHaveLength(0);
    expect(store.entries('dev-bad')).toHaveLength(0);
  }));

  it('rejects a connection with no passcode', () => withServer(async (port, store) => {
    const s = await connectTls(port);
    s.on('data', () => {}); // drain so the server's close propagates
    const closed = new Promise<void>((r) => s.on('close', () => r()));
    s.write(connection('dev-miss', {}));
    await closed;
    await sleep(50);
    expect(store.devices()).toHaveLength(0);
  }));

  it('closes the connection after 10 undecodable frames (invalid-close wired at transport)', () => withServer(async (port, store) => {
    const s = await connectTls(port);
    s.on('data', () => {});
    s.on('error', () => {});
    const control = readControl(s);
    s.write(connection('dev-noise', { passcode: identity.deviceToken }));
    await control; // ready
    let closed = false;
    const onClose = new Promise<void>((r) => s.on('close', () => { closed = true; r(); }));
    const bad = () => { const p = Buffer.from('not-json-' + Math.random()); const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(p.length)); s.write(Buffer.concat([h, p])); };
    for (let i = 0; i < 15 && !closed; i++) { bad(); await sleep(8); }
    await onClose;
    expect(closed).toBe(true);
    expect(store.entries('dev-noise')).toHaveLength(0);
  }));

  it('closes a pre-auth connection whose first frame is oversize', () => withServer(async (port, store) => {
    const s = await connectTls(port);
    s.on('data', () => {}); // drain so the server's close propagates
    const closed = new Promise<void>((r) => s.on('close', () => r()));
    // Announce a 128 KiB frame (over the 64 KiB pre-auth ceiling) before auth.
    const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(128 * 1024));
    s.write(h);
    await closed;
    expect(store.devices()).toHaveLength(0);
  }));
});
