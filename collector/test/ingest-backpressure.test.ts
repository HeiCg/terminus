import { describe, it, expect } from 'vitest';
import { ByteBudget, IngestScheduler } from '../src/ingestScheduler.js';
import { FrameAccumulator, MAX_FRAME_V2, OverloadError } from '../src/atlantis/frames.js';

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
});
