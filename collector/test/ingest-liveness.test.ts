import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { FrameAccumulator, OverloadError } from '../src/atlantis/frames.js';
import { startAtlantisServer } from '../src/atlantis/server.js';
import { createIngestShared, createDeviceServer } from '../src/deviceServer.js';
import { createIdentity } from '../src/security/identity.js';
import type { CollectorIdentity } from '../src/security/types.js';

const frame = (p: Buffer) => { const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(p.length)); return Buffer.concat([h, p]); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = (fn: () => boolean, ms = 2000) => new Promise<void>((res, rej) => {
  const t0 = Date.now();
  const i = setInterval(() => { if (fn()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')); } }, 5);
});

describe('FrameAccumulator incremental extraction (O02)', () => {
  it('waits for a split header before reporting a length', () => {
    const acc = new FrameAccumulator();
    const f = frame(Buffer.from('hello'));
    acc.append(f.subarray(0, 3));
    expect(acc.expectedLength()).toBeNull();
    expect(acc.hasCompleteFrame()).toBe(false);
    acc.append(f.subarray(3));
    expect(acc.expectedLength()).toBe(5);
    expect(acc.takeFrame()!.toString()).toBe('hello');
  });

  it('reassembles a payload delivered in fragments', () => {
    const acc = new FrameAccumulator();
    const f = frame(Buffer.from('abcdef'));
    acc.append(f.subarray(0, 10)); // header + 2 payload bytes
    expect(acc.hasCompleteFrame()).toBe(false);
    acc.append(f.subarray(10));
    expect(acc.hasCompleteFrame()).toBe(true);
    expect(acc.takeFrame()!.toString()).toBe('abcdef');
  });

  it('yields multiple frames one at a time without materializing an array', () => {
    const acc = new FrameAccumulator();
    acc.append(Buffer.concat([frame(Buffer.from('a')), frame(Buffer.from('bb')), frame(Buffer.from('ccc'))]));
    const out: string[] = [];
    for (let f = acc.takeFrame(); f; f = acc.takeFrame()) out.push(f.toString());
    expect(out).toEqual(['a', 'bb', 'ccc']);
  });

  it('reassembles a large frame fed one byte at a time', () => {
    const acc = new FrameAccumulator();
    const payload = Buffer.from('y'.repeat(5000));
    const f = frame(payload);
    let taken: Buffer | null = null;
    for (let i = 0; i < f.length; i++) { acc.append(f.subarray(i, i + 1)); const t = acc.takeFrame(); if (t) taken = t; }
    expect(taken?.equals(payload)).toBe(true);
  });

  it('rejects an oversize declared length', () => {
    const acc = new FrameAccumulator(16); // 16-byte frame ceiling
    acc.append(frame(Buffer.alloc(100)));
    expect(() => acc.expectedLength()).toThrow(OverloadError);
  });
});

describe('Atlantis TLS liveness (O12)', () => {
  let identity: CollectorIdentity;
  let dir: string;
  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-live-'));
    identity = await createIdentity(dir, { host: 'localhost', ips: ['127.0.0.1', '::1'], generation: 1, keyBits: 2048 }, { ingestPort: 8788, atlantisPort: 10909 });
  });
  afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  const envelope = (id: string, mt: string, inner: unknown) =>
    frame(gzipSync(Buffer.from(JSON.stringify({ id, messageType: mt, content: Buffer.from(JSON.stringify(inner)).toString('base64'), buildVersion: '1.0' }))));
  // Uncompressed so the wire size is predictable — used to force the byte budget past
  // its pause threshold deterministically.
  const rawEnvelope = (id: string, mt: string, inner: unknown) =>
    frame(Buffer.from(JSON.stringify({ id, messageType: mt, content: Buffer.from(JSON.stringify(inner)).toString('base64'), buildVersion: '1.0' })));
  const bigTraffic = (id: string, tid: string) =>
    rawEnvelope(id, 'traffic', { id: tid, startAt: 1, endAt: 1.1, packageType: 'http',
      request: { url: 'https://x/y', method: 'GET', headers: [{ key: 'x', value: 'A'.repeat(42000) }] },
      response: { statusCode: 200, headers: [] }, responseBodyData: null, error: null });

  it('keeps an authenticated but idle connection open and frees the slot on EOF', async () => {
    const store = new Store();
    const shared = createIngestShared();
    const srv = startAtlantisServer(store, 0, { identity, shared, host: '127.0.0.1' });
    await new Promise<void>((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const s = tls.connect({ host: '127.0.0.1', port, ca: [identity.certificatePem], servername: 'localhost', rejectUnauthorized: true });
      s.on('data', () => {}); // consume the ready control frame
      await new Promise((r) => s.once('secureConnect', r));
      s.write(envelope('dev-live', 'connection', { device: { name: 'n', model: 'iPhone15,2' }, project: { name: 'p', bundleIdentifier: 'b' }, passcode: identity.deviceToken }));
      await waitFor(() => shared.slots.count() === 1);
      // Idle: no traffic for a stretch that would trip any short idle timeout.
      await sleep(400);
      expect(shared.slots.count()).toBe(1);
      expect(s.destroyed).toBe(false);
      // EOF (Wi-Fi drop analogue): the slot is reclaimed.
      s.destroy();
      await waitFor(() => shared.slots.count() === 0);
      expect(shared.slots.count()).toBe(0);
    } finally {
      srv.close();
    }
  });

  it('delivers buffered complete frames after a backpressure pause and keeps the connection alive (IMPORTANT 2)', async () => {
    const store = new Store();
    // Small shared budget so a burst crosses the 75% pause threshold before the
    // 8-deep pending cap, forcing the read-gate pause with frames still buffered.
    const shared = createIngestShared(512 * 1024);
    const srv = startAtlantisServer(store, 0, { identity, shared, host: '127.0.0.1' });
    await new Promise<void>((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const s = tls.connect({ host: '127.0.0.1', port, ca: [identity.certificatePem], servername: 'localhost', rejectUnauthorized: true });
      s.on('data', () => {});
      s.on('error', () => {});
      await new Promise((r) => s.once('secureConnect', r));
      s.write(envelope('dev-bp', 'connection', { device: { name: 'n', model: 'iPhone15,2' }, project: { name: 'p', bundleIdentifier: 'b' }, passcode: identity.deviceToken }));
      // A burst larger than the budget: reading pauses, the scheduler drains, and
      // maybeResume re-enters extraction until every frame lands. The peer stays silent.
      const N = 40;
      for (let i = 0; i < N; i++) s.write(bigTraffic('dev-bp', `T-${i}`));
      await waitFor(() => store.entries('dev-bp').length === N, 5000);
      expect(store.entries('dev-bp')).toHaveLength(N);
      expect(s.destroyed).toBe(false); // not killed by the progress deadline
      s.destroy();
    } finally {
      srv.close();
    }
  });
});

describe('Atlantis pause-deadline backstop (round 2: budget livelock)', () => {
  let identity: CollectorIdentity;
  let dir: string;
  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-live2-'));
    identity = await createIdentity(dir, { host: 'localhost', ips: ['127.0.0.1', '::1'], generation: 1, keyBits: 2048 }, { ingestPort: 8788, atlantisPort: 10909 });
  });
  afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  const rawEnv = (id: string, mt: string, inner: unknown) =>
    frame(Buffer.from(JSON.stringify({ id, messageType: mt, content: Buffer.from(JSON.stringify(inner)).toString('base64'), buildVersion: '1.0' })));
  const connFrame = (k: string) => rawEnv(k, 'connection', { device: { name: 'n', model: 'iPhone15,2' }, project: { name: 'p', bundleIdentifier: 'b' }, passcode: identity.deviceToken });
  const trafficFrame = (k: string, tid: string) => rawEnv(k, 'traffic', { id: tid, startAt: 1, endAt: 1.1, packageType: 'http', request: { url: 'https://x/y', method: 'GET', headers: [] }, response: { statusCode: 200, headers: [] }, responseBodyData: null, error: null });
  const connectTls = (port: number) => new Promise<tls.TLSSocket>((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, ca: [identity.certificatePem], servername: 'localhost', rejectUnauthorized: true }, () => resolve(s));
    s.on('error', reject);
  });

  it('closes connections parked above the budget line (overload counted) and lets a fresh device resume', async () => {
    const store = new Store();
    const shared = createIngestShared(16 * 1024 * 1024); // 16 MiB: pause at 12, resume at 8
    // Short pause deadline so the parked offenders are closed inside the test window;
    // production uses 30 s. (Sub-line holders are bounded by the 10 s progress deadline,
    // which we don't wait on here — the test frees them directly to check recovery.)
    const srv = startAtlantisServer(store, 0, { identity, shared, host: '127.0.0.1', pauseDeadlineMs: 400 });
    await new Promise<void>((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      // Six devices each authenticate then declare a big frame and go silent, holding
      // ~2.5 MiB of concat reservation each — collectively pinning the budget above
      // the resume line with nothing left to drain.
      const socks: tls.TLSSocket[] = [];
      for (let i = 0; i < 6; i++) {
        const s = await connectTls(port);
        s.on('data', () => {}); s.on('error', () => {});
        s.write(connFrame(`park-${i}`));
        const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(Math.floor(2.5 * 1024 * 1024)));
        s.write(Buffer.concat([h, Buffer.alloc(2048)])); // header + partial payload → incomplete
        socks.push(s);
      }
      await new Promise((r) => setTimeout(r, 150));
      const peak = shared.budget.used();
      expect(peak).toBeGreaterThan(8 * 1024 * 1024); // budget genuinely pinned above the resume line

      // The parked offenders that crossed the pause line are closed by the bounded
      // pause deadline with the overload counter incremented, and the budget drops from
      // its peak — the livelock is broken (no reservation is held without a deadline).
      await waitFor(() => shared.scheduler.stats().overload >= 1 && shared.budget.used() < peak, 8000);
      expect(shared.scheduler.stats().overload).toBeGreaterThanOrEqual(1);
      expect(shared.budget.used()).toBeLessThan(peak);

      // Free the remaining sub-line holders (which production bounds via the 10s
      // progress deadline) so the shared budget resumes, then a fresh device is served.
      for (const s of socks) s.destroy();
      await waitFor(() => shared.budget.used() < 8 * 1024 * 1024, 4000);
      const good = await connectTls(port);
      good.on('data', () => {}); good.on('error', () => {});
      good.write(connFrame('after'));
      good.write(trafficFrame('after', 'A-1'));
      await waitFor(() => store.entries('after').length === 1, 6000);
      expect(store.entries('after')).toHaveLength(1);
      good.destroy();
    } finally {
      srv.close();
    }
  }, 20000);

  it('never closes a connection throttled solely by scheduler backlog (healthy budget)', async () => {
    const store = new Store();
    const shared = createIngestShared(); // default 128 MiB: the burst never pressures the budget
    // pauseDeadlineMs is tiny: if a pending-cap throttle armed it (the bug), the
    // connection would be killed almost immediately. It must not.
    const srv = startAtlantisServer(store, 0, { identity, shared, host: '127.0.0.1', pauseDeadlineMs: 1, progressDeadlineMs: 5000 });
    await new Promise<void>((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const s = await connectTls(port);
      s.on('data', () => {}); s.on('error', () => {});
      s.write(connFrame('back'));
      // A large burst of small frames arrives coalesced, so the reader submits past
      // the 8-deep pending cap and is repeatedly throttled — pure scheduler backlog,
      // budget untouched.
      const N = 60;
      for (let i = 0; i < N; i++) s.write(trafficFrame('back', `K-${i}`));
      await waitFor(() => store.entries('back').length === N, 6000);
      expect(store.entries('back')).toHaveLength(N);
      expect(s.destroyed).toBe(false);             // survived the backlog, not killed by a deadline
      expect(shared.budget.shouldPause()).toBe(false); // budget stayed healthy throughout
      expect(shared.scheduler.stats().overload).toBeGreaterThan(0); // backlog throttle genuinely occurred
      s.destroy();
    } finally {
      srv.close();
    }
  }, 15000);

  it('never trips the pause deadline for a single connection whose frame is below the pause line', async () => {
    const store = new Store();
    const shared = createIngestShared(); // default 128 MiB
    const srv = startAtlantisServer(store, 0, { identity, shared, host: '127.0.0.1', pauseDeadlineMs: 200 });
    await new Promise<void>((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const s = await connectTls(port);
      s.on('data', () => {}); s.on('error', () => {});
      s.write(connFrame('solo'));
      const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(4 * 1024 * 1024)); // 4 MiB, well below the 96 MiB pause line
      s.write(Buffer.concat([h, Buffer.alloc(4096)])); // incomplete, but never paused
      await new Promise((r) => setTimeout(r, 350)); // > pauseDeadlineMs
      expect(s.destroyed).toBe(false); // governed by the 10s progress deadline, not the pause backstop
      expect(shared.scheduler.stats().overload).toBe(0);
      s.destroy();
    } finally {
      srv.close();
    }
  });
});

describe('Device WSS slot accounting (IMPORTANT 4)', () => {
  let identity: CollectorIdentity;
  let dir: string;
  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-slot-'));
    identity = await createIdentity(dir, { host: 'localhost', ips: ['127.0.0.1', '::1'], generation: 1, keyBits: 2048 }, { ingestPort: 8788, atlantisPort: 10909 });
  });
  afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  it('does not leak connection slots when an authorized upgrade is aborted mid-handshake', async () => {
    const store = new Store();
    const shared = createIngestShared();
    const device = createDeviceServer(store, identity, shared);
    await new Promise<void>((r) => device.server.listen(0, '127.0.0.1', () => r()));
    const port = (device.server.address() as net.AddressInfo).port;
    try {
      const abortiveUpgrade = () => new Promise<void>((resolve) => {
        const s = tls.connect({ host: '127.0.0.1', port, ca: [identity.certificatePem], servername: 'localhost', rejectUnauthorized: true }, () => {
          s.write(`GET /ingest HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${identity.deviceToken}\r\n\r\n`);
          setTimeout(() => { s.destroy(); resolve(); }, Math.floor(Math.random() * 3));
        });
        s.on('error', () => resolve());
      });
      for (let i = 0; i < 20; i++) await abortiveUpgrade();
      await waitFor(() => shared.slots.count() === 0, 3000);
      expect(shared.slots.count()).toBe(0);
    } finally {
      device.close();
      await new Promise<void>((r) => device.server.close(() => r()));
    }
  });
});
