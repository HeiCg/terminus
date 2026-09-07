import { describe, it, expect } from 'vitest';
import { Store } from '../src/store.js';
import { AtlantisHarness, IngestHarness } from '../bench/run.js';
import * as fx from '../bench/fixtures.js';

const dev = fx.deviceId(0);
const frames = (n: number, bias = 0): Buffer[] => {
  const out = [fx.atlantisFrame(fx.atlantisConnection(dev))];
  for (let i = 0; i < n; i++) for (const env of fx.toAtlantisEnvelopes(fx.makeEvent(dev, i, { kind: 'http', bodyBias: bias }), i)) out.push(fx.atlantisFrame(env));
  return out;
};

describe('bench WorkStats contract', () => {
  it('holds received === applied + dropped + pendingItems and drains clean', async () => {
    const store = new Store();
    const h = new AtlantisHarness(store);
    for (const f of frames(50)) h.feed(f);
    h.assertInvariant();                         // invariant holds mid-flight (items pending)
    expect(h.stats().pendingItems).toBeGreaterThan(0);
    await h.stopAndDrain();
    const s = h.stats();
    expect(s.pendingBytes).toBe(0);
    expect(s.activeJobs).toBe(0);
    expect(s.received).toBe(s.applied + s.dropped + s.pendingItems);
    expect(s.applied).toBe(51);                  // 1 connection + 50 traffic
    expect(store.entries(dev).length).toBe(50);
  });

  it('counts partial framing bytes and discards them on drain', async () => {
    const store = new Store();
    const h = new AtlantisHarness(store);
    const wire = Buffer.concat(frames(20, 1));
    h.feed(wire.subarray(0, wire.length - 6));   // withhold the tail of the last frame
    expect(h.stats().pendingBytes).toBeGreaterThan(0);
    h.assertInvariant();
    await h.stopAndDrain();
    expect(h.stats().pendingBytes).toBe(0);
    expect(h.leftoverBytes).toBeGreaterThan(0);  // partial bytes accounted, not lost silently
  });

  it('cancellation accounts queued items as drops and still drains clean', async () => {
    const store = new Store();
    const h = new AtlantisHarness(store, 64, 2);
    for (const f of frames(120)) h.feed(f);      // overflow the 64-deep buffer
    expect(h.stats().pendingItems).toBeGreaterThan(0);
    await h.cancelAndDrain();
    const s = h.stats();
    expect(s.pendingItems).toBe(0);
    expect(s.activeJobs).toBe(0);
    expect(s.received).toBe(s.applied + s.dropped);
    expect(h.dropReasons.cancelled ?? 0).toBeGreaterThan(0);
  });

  it('redacts synthetic sensitive headers before the store (no token leaks)', async () => {
    const store = new Store();
    const h = new AtlantisHarness(store);
    for (const f of frames(4)) h.feed(f);
    await h.stopAndDrain();
    for (const e of store.entries(dev)) {
      const auth = e.requestHeaders['authorization'];
      if (auth !== undefined) expect(auth).toBe('***');   // fake Bearer token masked
    }
  });

  it('legacy own-protocol path drops messages before hello, applies after', async () => {
    const store = new Store();
    const h = new IngestHarness(store);
    for (const m of fx.toDeviceMessages(fx.makeEvent(dev, 0, { kind: 'http' }), 0)) h.feed(JSON.stringify(m));
    h.feed(JSON.stringify(fx.helloMessage(dev)));
    for (const m of fx.toDeviceMessages(fx.makeEvent(dev, 1, { kind: 'http' }), 1)) h.feed(JSON.stringify(m));
    await h.stopAndDrain();
    const s = h.stats();
    expect(s.received).toBe(s.applied + s.dropped + s.pendingItems);
    expect(h.dropReasons.no_hello ?? 0).toBeGreaterThan(0);
    expect(store.entries(dev).length).toBe(1);   // only the post-hello request lands
  });
});
