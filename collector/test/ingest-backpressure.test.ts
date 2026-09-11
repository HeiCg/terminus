import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { ByteBudget, IngestScheduler } from '../src/ingestScheduler.js';
import { FrameAccumulator, MAX_FRAME_V2, OverloadError } from '../src/atlantis/frames.js';
import { createDeviceServer, createIngestShared } from '../src/deviceServer.js';
import { createIdentity } from '../src/security/identity.js';
import { Store } from '../src/store.js';

const frame = (p: Buffer) => { const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(p.length)); return Buffer.concat([h, p]); };
const waitFor = (fn: () => boolean, ms = 2000) => new Promise<void>((res, rej) => {
  const t0 = Date.now();
  const i = setInterval(() => { if (fn()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')); } }, 5);
});

describe('ByteBudget (O01/clientes lentos)', () => {
  it('pauses at 75% and resumes below 50% with hysteresis', () => {
    const b = new ByteBudget(1000);
    expect(b.reserve(700)).toBe(true);
    expect(b.shouldPause()).toBe(false);        // 70%
    expect(b.reserve(60)).toBe(true);
    expect(b.shouldPause()).toBe(true);          // 76% → paused
    b.release(200);                              // 56% → still paused (hysteresis)
    expect(b.shouldPause()).toBe(true);
    b.release(100);                              // 46% → resume
    expect(b.shouldPause()).toBe(false);
  });
  it('refuses a reservation past the hard cap without dropping state', () => {
    const b = new ByteBudget(100);
    expect(b.reserve(80)).toBe(true);
    expect(b.reserve(40)).toBe(false);           // would exceed 100
    expect(b.used()).toBe(80);                   // unchanged
  });
});

describe('FrameAccumulator budget accounting (O02)', () => {
  it('transfers frame ownership on take, releasing only the input bytes', () => {
    const budget = new ByteBudget(64 * 1024 * 1024);
    const acc = new FrameAccumulator(MAX_FRAME_V2, budget);
    const payload = Buffer.from('x'.repeat(1000));
    acc.append(frame(payload));
    expect(acc.expectedLength()).toBe(1000);
    expect(acc.hasCompleteFrame()).toBe(true);
    const out = acc.takeFrame()!;
    expect(out.equals(payload)).toBe(true);
    // Only the owned frame (1000B) stays reserved; header+input were released.
    expect(budget.used()).toBe(1000);
  });
  it('completes a maximum-size frame without a pause deadlock', () => {
    const budget = new ByteBudget(128 * 1024 * 1024);
    const acc = new FrameAccumulator(MAX_FRAME_V2, budget);
    const payload = Buffer.alloc(MAX_FRAME_V2); // 8 MiB, the v2 ceiling
    acc.append(frame(payload));
    expect(acc.hasCompleteFrame()).toBe(true);
    const out = acc.takeFrame()!;
    expect(out.length).toBe(MAX_FRAME_V2);
    expect(budget.shouldPause()).toBe(false); // 8 MiB is far below the 96 MiB pause line
  });
  it('raises OverloadError when a chunk would breach the hard cap', () => {
    const budget = new ByteBudget(100);
    const acc = new FrameAccumulator(MAX_FRAME_V2, budget);
    expect(() => acc.append(Buffer.alloc(200))).toThrow(OverloadError);
  });

  it('releases the concat reservation on dispose (CRITICAL 1: no budget leak)', () => {
    const budget = new ByteBudget(64 * 1024 * 1024);
    const acc = new FrameAccumulator(MAX_FRAME_V2, budget);
    // Header declaring a 1 MiB frame, then the peer vanishes before sending payload.
    const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(1024 * 1024));
    acc.append(h);
    expect(acc.expectedLength()).toBe(1024 * 1024); // reserves 1 MiB of concat headroom
    expect(budget.used()).toBeGreaterThan(1024 * 1024);
    acc.dispose();
    expect(budget.used()).toBe(0); // both input AND concat released
  });

  it('rejects an oversize pre-auth declaration BEFORE reserving budget (CRITICAL 1)', () => {
    const budget = new ByteBudget(128 * 1024 * 1024);
    const acc = new FrameAccumulator(64 * 1024, budget); // 64 KiB pre-auth ceiling
    const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(8 * 1024 * 1024)); // declare 8 MiB
    acc.append(h);
    expect(() => acc.expectedLength()).toThrow(OverloadError);
    expect(budget.used()).toBe(8);   // only the 8 header bytes were ever reserved
    acc.dispose();
    expect(budget.used()).toBe(0);
  });
});

describe('IngestScheduler (O01)', () => {
  const bigBudget = () => new ByteBudget(128 * 1024 * 1024);

  it('preserves FIFO order within a connection and processes every connection', async () => {
    const order: string[] = [];
    const sched = new IngestScheduler({ budget: bigBudget(), process: async (id, f) => { order.push(`${id}:${f.toString()}`); return { ok: true }; } });
    for (const n of ['1', '2', '3', '4']) expect(sched.submit('A', Buffer.from(n))).toBe('accepted');
    expect(sched.submit('B', Buffer.from('x'))).toBe('accepted');
    await waitFor(() => order.length === 5);
    expect(order.filter((o) => o.startsWith('A:'))).toEqual(['A:1', 'A:2', 'A:3', 'A:4']);
    expect(order.some((o) => o === 'B:x')).toBe(true);
  });

  it('interleaves fairly so a light connection is not starved by a noisy one', async () => {
    const order: string[] = [];
    const sched = new IngestScheduler({ budget: bigBudget(), process: async (id) => { order.push(id); return { ok: true }; } });
    for (let i = 0; i < 8; i++) sched.submit('noisy', Buffer.from(String(i)));
    sched.submit('light', Buffer.from('l'));
    await waitFor(() => order.length === 9);
    // With 2 decode slots and round-robin, the light connection runs in the first batch.
    expect(order.indexOf('light')).toBeLessThan(2);
  });

  it('returns overload past the per-connection pending cap of 8', () => {
    const sched = new IngestScheduler({ budget: bigBudget(), process: () => new Promise<{ ok: true }>(() => {}) });
    const results: string[] = [];
    for (let i = 0; i < 9; i++) results.push(sched.submit('C', Buffer.from(String(i))));
    expect(results.slice(0, 8).every((r) => r === 'accepted')).toBe(true);
    expect(results[8]).toBe('overload');
    expect(sched.stats().overload).toBe(1);
  });

  it('releases queued budget and forgets a connection on close', () => {
    const budget = new ByteBudget(1000);
    const sched = new IngestScheduler({ budget, process: () => new Promise<{ ok: true }>(() => {}) });
    // Mimic owned frames: reserve before submit as the transport does.
    for (let i = 0; i < 3; i++) { budget.reserve(100); sched.submit('D', Buffer.alloc(100)); }
    expect(budget.used()).toBe(300);
    sched.close('D'); // synchronous, before the pump drains anything
    expect(budget.used()).toBe(0);
    expect(sched.stats().queued).toBe(0);
  });

  it('aggregates invalid-frame logs BY REASON, not one opaque bucket', async () => {
    let now = 1000;
    const warns: string[] = [];
    // Distinct reason per frame content; log flushes only once >=5s has elapsed.
    const sched = new IngestScheduler({
      budget: bigBudget(), now: () => now,
      log: { warn: (...a: unknown[]) => warns.push(a.join(' ')) },
      process: async (_id, f) => ({ ok: false, reason: f.toString() }),
    });
    for (const r of ['bad_json', 'bad_json', 'not_device_message']) sched.submit('X', Buffer.from(r));
    await waitFor(() => sched.stats().invalid === 3);
    now = 7000; // cross the 5s throttle so the next invalid flushes the breakdown
    sched.submit('X', Buffer.from('threw'));
    await waitFor(() => warns.length >= 1);
    const line = warns.join('\n');
    expect(line).toContain('bad_json=2');
    expect(line).toContain('not_device_message=1');
  });

  it('closes an emitter after 10 invalid frames in the window', async () => {
    const closed: string[] = [];
    const sched = new IngestScheduler({ budget: bigBudget(), process: async () => ({ ok: false, reason: 'bad' }), onOverload: (id) => closed.push(id) });
    // Space submissions so each is processed (the 8-deep queue never overflows) and
    // the invalid counter actually reaches 10.
    for (let i = 0; i < 15 && closed.length === 0; i++) { sched.submit('bad', Buffer.from(String(i))); await new Promise((r) => setTimeout(r, 3)); }
    await waitFor(() => closed.length >= 1);
    expect(closed).toContain('bad');
    expect(sched.stats().closedForErrors).toBeGreaterThanOrEqual(1);
  });

  it('reports a submit to an already-closed (still-draining) connection as closed, not overload', async () => {
    // A hanging processor keeps the first frame in-flight so close() cannot forget the
    // connection immediately — it lingers with closed=true while its decode drains.
    const sched = new IngestScheduler({ budget: bigBudget(), process: () => new Promise<{ ok: true }>(() => {}) });
    sched.submit('Z', Buffer.from('a'));
    await waitFor(() => sched.stats().activeDecodes === 1);
    sched.close('Z');
    expect(sched.submit('Z', Buffer.from('b'))).toBe('closed');
    expect(sched.stats().overload).toBe(0); // a closed connection is not an overload
  });

  it('exposes paused/pauses counters driven by notePause/noteResume', () => {
    const sched = new IngestScheduler({ budget: bigBudget(), process: async () => ({ ok: true }) });
    expect(sched.stats().paused).toBe(0);
    expect(sched.stats().pauses).toBe(0);
    sched.notePause();
    sched.notePause();
    expect(sched.stats().paused).toBe(2);
    expect(sched.stats().pauses).toBe(2);
    sched.noteResume();
    expect(sched.stats().paused).toBe(1);
    expect(sched.stats().pauses).toBe(2); // total is monotonic
    sched.noteResume();
    sched.noteResume(); // never goes negative
    expect(sched.stats().paused).toBe(0);
  });

  it('fires onDrain once, after the pending queue drains below the low-water mark', async () => {
    const sched = new IngestScheduler({ budget: bigBudget(), process: async () => ({ ok: true }) });
    for (let i = 0; i < 8; i++) expect(sched.submit('P', Buffer.from(String(i)))).toBe('accepted');
    // 9th does not fit: the per-connection pending cap of 8 is full.
    expect(sched.submit('P', Buffer.from('8'))).toBe('overload');

    let drained = 0;
    sched.onDrain('P', () => { drained++; }); // registered while the queue is still full
    await waitFor(() => drained === 1);
    // The fast processor keeps draining past the mark, but the callback fires at most
    // once per registration.
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(1);
  });

  it('does not fire onDrain while the pending queue stays full', async () => {
    const sched = new IngestScheduler({ budget: bigBudget(), process: () => new Promise<{ ok: true }>(() => {}) });
    for (let i = 0; i < 8; i++) sched.submit('R', Buffer.from(String(i)));
    let fired = false;
    sched.onDrain('R', () => { fired = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(false); // one frame is stuck decoding; the queue never falls to <= 4
  });

  it('does not fire onDrain for a connection closed before it drains', async () => {
    const sched = new IngestScheduler({ budget: bigBudget(), process: () => new Promise<{ ok: true }>(() => {}) });
    for (let i = 0; i < 8; i++) sched.submit('Q', Buffer.from(String(i)));
    let fired = false;
    sched.onDrain('Q', () => { fired = true; });
    sched.close('Q');
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(false);
  });
});

// End-to-end WSS back-pressure: a real device connection over TLS whose burst
// exceeds the ingest pending caps must be paused, not dropped (the trial finding).
describe('WSS ingest back-pressure (deviceServer)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

  // Bring up a device server on an ephemeral port with a fresh temp state dir. Never
  // binds the live collector's 8787/8788/8789/10909.
  const bootDeviceServer = async (shared = createIngestShared(), opts: { pauseMaxMs?: number } = {}) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-bp-'));
    const identity = await createIdentity(dir, { host: 'localhost', ips: ['127.0.0.1', '::1'], generation: 1, keyBits: 2048 }, { ingestPort: 8788, atlantisPort: 10909 });
    const store = new Store();
    const device = createDeviceServer(store, identity, shared, opts);
    await new Promise<void>((r) => device.server.listen(0, '127.0.0.1', () => r()));
    const port = (device.server.address() as net.AddressInfo).port;
    cleanups.push(async () => { device.close(); await fsp.rm(dir, { recursive: true, force: true }); });
    return { store, identity, device, port, shared };
  };

  const connect = (port: number, identity: Awaited<ReturnType<typeof createIdentity>>) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ingest`, {
      ca: [identity.certificatePem], servername: 'localhost', rejectUnauthorized: true,
      headers: { authorization: `Bearer ${identity.deviceToken}` },
    });
    const closes: number[] = [];
    ws.on('close', (code) => closes.push(code));
    ws.on('error', () => {}); // a 1013 close surfaces as an error on some node builds
    return { ws, closes };
  };

  const hello = (deviceId: string) => JSON.stringify({ type: 'hello', deviceId, platform: 'android', appVersion: '1.0.0', buildProfile: 'preview', dropped: 0, ts: Date.now() });
  const request = (id: string, i: number) => JSON.stringify({ type: 'request', id, ts: 1_700_000_000_000 + i, method: 'GET', url: `https://api.example.io/n/${i}`, headers: {}, body: null, bodySize: 0, source: 'xhr' });

  it('keeps the connection and ingests a 64+ frame burst in order, with zero closes', async () => {
    const { store, identity, port, shared } = await bootDeviceServer();
    const { ws, closes } = connect(port, identity);
    await new Promise((r) => ws.on('open', r));

    const N = 80; // well past the per-connection (8) and global (64) pending caps
    ws.send(hello('burst'));
    const ids: string[] = [];
    for (let i = 0; i < N; i++) { const id = `r-${i}`; ids.push(id); ws.send(request(id, i)); }

    // All frames land, in per-connection order.
    await waitFor(() => store.entries('burst').length === N, 8000);
    expect(store.entries('burst').map((e) => e.id)).toEqual(ids);

    // The connection is still open and was never closed (the trial finding was 25
    // closes in ~10s); back-pressure engaged at least once instead.
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(closes).toEqual([]); // zero closes — the whole point
    expect(shared.scheduler.stats().pauses).toBeGreaterThanOrEqual(1);
    // Back to rest once drained.
    await waitFor(() => shared.scheduler.stats().paused === 0, 2000);
    ws.close();
  }, 15000);

  it('closes with 1013 (counted as overload) when a paused connection never drains within the deadline', async () => {
    const shared = createIngestShared();
    // Occupy both global decode slots with two connections whose decode never resolves
    // (one hung frame per connection, since a single connection serializes its decode),
    // so the burst below can never drain and stays parked past the deadline.
    shared.scheduler.registerHandler('blocker1', () => new Promise<{ ok: true }>(() => {}));
    shared.scheduler.registerHandler('blocker2', () => new Promise<{ ok: true }>(() => {}));
    shared.scheduler.submit('blocker1', Buffer.from('a'));
    shared.scheduler.submit('blocker2', Buffer.from('b'));
    await waitFor(() => shared.scheduler.stats().activeDecodes === 2, 2000);

    const { identity, port } = await bootDeviceServer(shared, { pauseMaxMs: 200 });
    const { ws, closes } = connect(port, identity);
    await new Promise((r) => ws.on('open', r));

    ws.send(hello('stuck'));
    for (let i = 0; i < 20; i++) ws.send(request(`s-${i}`, i)); // fills the pending cap, then parks

    await waitFor(() => closes.includes(1013), 5000);
    expect(closes).toContain(1013);
    expect(shared.scheduler.stats().overload).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('closes immediately (no pause) on a budget overload — a different failure', async () => {
    const shared = createIngestShared(1000); // 1 KiB shared byte budget
    const { identity, port } = await bootDeviceServer(shared);
    const { ws, closes } = connect(port, identity);
    await new Promise((r) => ws.on('open', r));

    // A single frame larger than the whole budget: reserve() fails before the scheduler
    // is ever consulted, so this closes at once rather than back-pressuring.
    ws.send(Buffer.alloc(2000, 0x20));

    await waitFor(() => closes.includes(1013), 4000);
    expect(closes).toContain(1013);
    expect(shared.scheduler.stats().pauses).toBe(0); // never entered back-pressure
  }, 15000);
});
