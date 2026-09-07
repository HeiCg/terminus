import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { startAtlantisServer } from '../src/atlantis/server.js';
import { createDeviceServer, createIngestShared } from '../src/deviceServer.js';
import { createIdentity } from '../src/security/identity.js';
import { Store } from '../src/store.js';
import { createCollectorHarness, type CollectorHarness } from './fixtures/harness.js';
import type { CollectorIdentity } from '../src/security/types.js';
import events from './fixtures/events.json';

let harness: CollectorHarness;
let cookie = '';
let identity: CollectorIdentity;
let dir: string;
let device: ReturnType<typeof createDeviceServer>;
let devicePort = 0;
let atlantis: tls.Server;
let atlantisPort = 0;

beforeAll(async () => {
  harness = await createCollectorHarness();
  cookie = await harness.login();
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-int-'));
  identity = await createIdentity(dir, { host: 'localhost', ips: ['127.0.0.1', '::1'], generation: 1, keyBits: 2048 }, { ingestPort: 8788, atlantisPort: 10909 });
  const shared = createIngestShared();
  device = createDeviceServer(harness.store, identity, shared);
  await new Promise<void>((r) => device.server.listen(0, '127.0.0.1', () => r()));
  devicePort = (device.server.address() as net.AddressInfo).port;
  atlantis = startAtlantisServer(harness.store, 0, { identity, shared, host: '127.0.0.1' });
  await new Promise<void>((r) => atlantis.once('listening', () => r()));
  atlantisPort = (atlantis.address() as net.AddressInfo).port;
});
afterAll(async () => {
  device.close(); atlantis.close();
  await harness.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

const until = (fn: () => boolean) => new Promise<void>((res, rej) => {
  const t0 = Date.now();
  const i = setInterval(() => {
    if (fn()) { clearInterval(i); res(); }
    else if (Date.now() - t0 > 2000) { clearInterval(i); rej(new Error('timeout')); }
  }, 10);
});
const waitFor2 = (fn: () => boolean, ms: number) => new Promise<void>((res, rej) => {
  const t0 = Date.now();
  const i = setInterval(() => {
    if (fn()) { clearInterval(i); res(); }
    else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')); }
  }, 10);
});
const frame = (obj: unknown) => {
  const p = gzipSync(Buffer.from(JSON.stringify(obj)));
  const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(p.length));
  return Buffer.concat([h, p]);
};
const envelope = (id: string, mt: string, inner: unknown) =>
  frame({ id, messageType: mt, content: Buffer.from(JSON.stringify(inner)).toString('base64'), buildVersion: '1.0' });

describe('integration (TLS ingests)', () => {
  it('ingests device events over WSS+TLS and exports HAR', async () => {
    const store = harness.store;
    const ws = new WebSocket(`wss://127.0.0.1:${devicePort}/ingest`, {
      ca: [identity.certificatePem], servername: 'localhost', rejectUnauthorized: true,
      headers: { authorization: `Bearer ${identity.deviceToken}` },
    });
    await new Promise((r) => ws.on('open', r));
    for (const e of events) ws.send(JSON.stringify(e));
    await until(() => store.entries('d1').filter((e) => e.status !== null).length === 2);
    const har = await (await fetch(`${harness.url}/export.har?device=d1`, { headers: { cookie } })).json();
    // Union of HTTP and WS (T10/R5): the 2 HTTP exchanges plus one synthetic entry
    // for the captured (unlinked) WebSocket session carrying its frames.
    expect(har.log.entries).toHaveLength(3);
    const wsEntry = har.log.entries.find((e: any) => e._terminus?.synthetic);
    expect(wsEntry._webSocketMessages).toHaveLength(1);
    expect(wsEntry._terminus.close.code).toBe(1000);
    expect(store.wsSessions('d1')[0].frames).toHaveLength(1);
    expect(store.wsSessions('d1')[0].closeCode).toBe(1000);
    ws.close();
  });

  it('fairly serves a noisy and a light device over real TLS, preserving per-connection order (O01)', async () => {
    const store = new Store();
    const shared = createIngestShared();
    const srv = startAtlantisServer(store, 0, { identity, shared, host: '127.0.0.1' });
    await new Promise<void>((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;

    const connectAuthed = async (deviceKey: string) => {
      const s = tls.connect({ host: '127.0.0.1', port, ca: [identity.certificatePem], servername: 'localhost', rejectUnauthorized: true });
      s.on('data', () => {});
      s.on('error', () => {});
      await new Promise((r) => s.once('secureConnect', r));
      s.write(envelope(deviceKey, 'connection', { device: { name: 'n', model: 'iPhone15,2' }, project: { name: 'p', bundleIdentifier: 'b' }, passcode: identity.deviceToken }));
      return s;
    };
    const traffic = (deviceKey: string, tid: string) =>
      envelope(deviceKey, 'traffic', { id: tid, startAt: 1, endAt: 1.1, packageType: 'http', request: { url: 'https://x/y', method: 'GET', headers: [] }, response: { statusCode: 200, headers: [] }, responseBodyData: null, error: null });

    // Event-loop responsiveness is exercised implicitly: the light device must keep
    // completing while the noisy one floods (asserted below). No ms threshold in CI.
    try {
      const noisy = await connectAuthed('noisy');
      const light = await connectAuthed('light');
      const NOISY = 40, LIGHT = 5;
      // Interleave both devices, yielding to the event loop each frame so the shared
      // scheduler stays within its per-connection pending cap (limits hold) while the
      // light device keeps getting served alongside the noisy one.
      for (let i = 0; i < NOISY; i++) {
        noisy.write(traffic('noisy', `N-${i}`));
        if (i < LIGHT) light.write(traffic('light', `L-${i}`));
        await new Promise((r) => setImmediate(r));
      }

      // Both devices fully processed; the light one is not starved.
      await waitFor2(() => store.entries('noisy').length === NOISY && store.entries('light').length === LIGHT, 6000);
      // Per-connection FIFO order preserved.
      expect(store.entries('noisy').map((e) => e.id)).toEqual([...Array(NOISY)].map((_, i) => `N-${i}`));
      expect(store.entries('light').map((e) => e.id)).toEqual([...Array(LIGHT)].map((_, i) => `L-${i}`));

      // Queues drain on disconnect + shutdown.
      noisy.destroy(); light.destroy();
      await waitFor2(() => shared.scheduler.stats().queued === 0 && shared.scheduler.stats().connections === 0, 3000);
      expect(shared.scheduler.stats().queued).toBe(0);
    } finally {
      srv.close();
    }
  }, 20000);

  it('drains a failed-auth connection to zero while other devices keep processing (O01 auth_error)', async () => {
    const store = new Store();
    const shared = createIngestShared();
    const srv = startAtlantisServer(store, 0, { identity, shared, host: '127.0.0.1' });
    await new Promise<void>((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      // Good device authenticates and streams.
      const good = tls.connect({ host: '127.0.0.1', port, ca: [identity.certificatePem], servername: 'localhost', rejectUnauthorized: true });
      good.on('data', () => {}); good.on('error', () => {});
      await new Promise((r) => good.once('secureConnect', r));
      good.write(envelope('good', 'connection', { device: { name: 'n', model: 'iPhone15,2' }, project: { name: 'p', bundleIdentifier: 'b' }, passcode: identity.deviceToken }));

      // Bad device presents a wrong token, then a traffic frame that must never apply.
      const bad = tls.connect({ host: '127.0.0.1', port, ca: [identity.certificatePem], servername: 'localhost', rejectUnauthorized: true });
      bad.on('data', () => {}); bad.on('error', () => {});
      const badClosed = new Promise<void>((r) => bad.on('close', () => r()));
      await new Promise((r) => bad.once('secureConnect', r));
      bad.write(envelope('bad', 'connection', { device: { name: 'n', model: 'iPhone15,2' }, project: { name: 'p', bundleIdentifier: 'b' }, passcode: 'wrong-token' }));
      bad.write(envelope('bad', 'traffic', { id: 'B-1', startAt: 1, endAt: 1.1, packageType: 'http', request: { url: 'https://x/y', method: 'GET', headers: [] }, response: { statusCode: 200, headers: [] }, responseBodyData: null, error: null }));

      const N = 10;
      for (let i = 0; i < N; i++) { good.write(envelope('good', 'traffic', { id: `G-${i}`, startAt: 1, endAt: 1.1, packageType: 'http', request: { url: 'https://x/y', method: 'GET', headers: [] }, response: { statusCode: 200, headers: [] }, responseBodyData: null, error: null })); await new Promise((r) => setImmediate(r)); }

      await badClosed; // failed auth tore the connection down
      await waitFor2(() => store.entries('good').length === N, 4000);

      // The bad connection left nothing behind and did not block or reorder the good one.
      expect(store.entries('good')).toHaveLength(N);
      expect(store.entries('good').map((e) => e.id)).toEqual([...Array(N)].map((_, i) => `G-${i}`));
      expect(store.entries('bad')).toHaveLength(0);
      await waitFor2(() => shared.scheduler.stats().queued === 0, 2000);
      expect(shared.scheduler.stats().queued).toBe(0);
      expect(shared.slots.count()).toBe(1); // only the good device holds a slot
      good.destroy();
    } finally {
      srv.close();
    }
  }, 15000);

  it('ingests atlantis frames over TLS after a token handshake', async () => {
    const store = harness.store;
    const s = tls.connect({ host: '127.0.0.1', port: atlantisPort, ca: [identity.certificatePem], servername: 'localhost', rejectUnauthorized: true });
    s.on('data', () => {}); // consume the ready control frame
    await new Promise((r) => s.once('secureConnect', r));
    s.write(envelope('com.example.app-iPhone', 'connection', { device: { name: 'n', model: 'iPhone15,2' }, project: { name: 'p', bundleIdentifier: 'b' }, passcode: identity.deviceToken }));
    const inner = { id: 'A1', startAt: 1, endAt: 1.1, packageType: 'http', request: { url: 'https://x/y', method: 'GET', headers: [] }, response: { statusCode: 204, headers: [] }, responseBodyData: null, error: null };
    s.write(envelope('com.example.app-iPhone', 'traffic', inner));
    await until(() => store.entries('com.example.app-iPhone').length === 1);
    expect(store.entries('com.example.app-iPhone')[0].status).toBe(204);
    s.destroy();
  });
});
