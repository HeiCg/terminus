import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { Store } from '../src/store.js';
import { startAtlantisServer, type AtlantisOpts } from '../src/atlantis/server.js';
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
const control = (id: string, inner: unknown) => envelope(id, 'control', inner);

let identity: CollectorIdentity;
let dir: string;
beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-atlping-'));
  identity = await createIdentity(dir, { host: 'localhost', ips: ['127.0.0.1', '::1'], generation: 1, keyBits: 2048 }, { ingestPort: 8788, atlantisPort: 10909 });
});
afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

async function withServer<T>(opts: Partial<AtlantisOpts>, fn: (port: number, store: Store, srv: tls.Server) => Promise<T>): Promise<T> {
  const store = new Store();
  const srv = startAtlantisServer(store, 0, { identity, host: '127.0.0.1', ...opts });
  await new Promise<void>((r) => srv.once('listening', r));
  const port = (srv.address() as net.AddressInfo).port;
  try { return await fn(port, store, srv); } finally { srv.close(); }
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

// Collect every control-frame type the server sends over the connection.
function collectControls(sock: tls.TLSSocket): string[] {
  const acc = new FrameAccumulator();
  const types: string[] = [];
  sock.on('data', (chunk: Buffer) => {
    let frames: Buffer[]; try { frames = acc.push(chunk); } catch { return; }
    for (const f of frames) {
      try {
        const env = JSON.parse(f.toString('utf8'));
        if (env.messageType === 'control') types.push(JSON.parse(Buffer.from(env.content, 'base64').toString('utf8')).type);
      } catch { /* not a control frame */ }
    }
  });
  return types;
}

describe('atlantis server-side ping', () => {
  it('sends periodic ping control frames and stays connected', () => withServer({ pingMs: 50 }, async (port) => {
    const s = await connectTls(port);
    const types = collectControls(s);
    s.write(connection('dev-ping', { passcode: identity.deviceToken }));
    await until(() => types.filter((t) => t === 'ping').length >= 2, 200);
    expect(types[0]).toBe('ready');
    expect(types.filter((t) => t === 'ping').length).toBeGreaterThanOrEqual(2);
    expect(s.destroyed).toBe(false);
    s.destroy();
  }));

  it('sends no ping frames when the interval is 0 (disabled)', () => withServer({ pingMs: 0 }, async (port) => {
    const s = await connectTls(port);
    const types = collectControls(s);
    s.write(connection('dev-noping', { passcode: identity.deviceToken }));
    await until(() => types.includes('ready'), 500);
    await sleep(200);
    expect(types.filter((t) => t === 'ping')).toHaveLength(0);
    expect(s.destroyed).toBe(false);
    s.destroy();
  }));

  it('is driven by TERMINUS_ATLANTIS_PING_MS when no opt is given', async () => {
    process.env.TERMINUS_ATLANTIS_PING_MS = '50';
    try {
      await withServer({}, async (port) => {
        const s = await connectTls(port);
        const types = collectControls(s);
        s.write(connection('dev-env', { passcode: identity.deviceToken }));
        await until(() => types.filter((t) => t === 'ping').length >= 2, 500);
        expect(types.filter((t) => t === 'ping').length).toBeGreaterThanOrEqual(2);
        s.destroy();
      });
    } finally { delete process.env.TERMINUS_ATLANTIS_PING_MS; }
  });

  it('closes the socket and clears the timer when a ping write throws (no leak)', () => withServer({ pingMs: 40 }, async (port, _store, srv) => {
    let pingWrites = 0;
    let serverSock: tls.TLSSocket | null = null;
    srv.on('secureConnection', (tlsSock) => {
      serverSock = tlsSock;
      const orig = tlsSock.write.bind(tlsSock);
      (tlsSock as unknown as { write: (...a: unknown[]) => unknown }).write = (data: unknown, ...rest: unknown[]) => {
        let isPing = false;
        if (Buffer.isBuffer(data) && data.length > 8) {
          try {
            const env = JSON.parse(data.subarray(8).toString('utf8')) as { messageType?: string; content?: string };
            if (env.messageType === 'control' && env.content && (JSON.parse(Buffer.from(env.content, 'base64').toString('utf8')) as { type?: string }).type === 'ping') isPing = true;
          } catch { /* not a length-prefixed frame */ }
        }
        if (isPing) { pingWrites += 1; throw new Error('boom write'); }
        return (orig as (...a: unknown[]) => unknown)(data, ...rest);
      };
    });
    const s = await connectTls(port);
    s.on('error', () => {});
    s.write(connection('dev-throw', { passcode: identity.deviceToken }));
    await until(() => serverSock != null && (serverSock as tls.TLSSocket).destroyed, 1000);
    expect(pingWrites).toBe(1);                 // the throwing ping
    // The interval was cleared on the write failure: wait past several intervals
    // and confirm no further ping was attempted (no leaked timer).
    await sleep(200);
    expect(pingWrites).toBe(1);
    expect((serverSock as unknown as tls.TLSSocket).destroyed).toBe(true);
    s.destroy();
  }));

  it('ignores a pong control frame from the client (no error, not counted as traffic)', () => withServer({ pingMs: 0 }, async (port, store) => {
    const s = await connectTls(port);
    const types = collectControls(s);
    s.on('error', () => {});
    s.write(connection('dev-pong', { passcode: identity.deviceToken }));
    await until(() => types.includes('ready'), 500);
    // More pongs than the invalid-frame close threshold (10): if pongs were
    // treated as undecodable the socket would be torn down here.
    for (let i = 0; i < 12; i++) { s.write(control('dev-pong', { type: 'pong', protocolVersion: 2 })); await sleep(8); }
    // A real traffic frame still lands, proving the connection is alive.
    s.write(traffic('dev-pong', 'T-pong'));
    await until(() => store.entries('dev-pong').length === 1, 1000);
    await sleep(50);
    expect(s.destroyed).toBe(false);
    expect(store.entries('dev-pong')).toHaveLength(1); // the pongs were not counted as traffic
    s.destroy();
  }));
});
