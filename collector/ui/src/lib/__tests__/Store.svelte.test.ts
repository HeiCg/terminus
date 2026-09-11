import { describe, it, expect } from 'vitest';
import { Store } from '../state/Store.svelte.js';
import type { SnapshotMessage, EntrySummary, BodyRef } from '../protocol.js';

const bodyRef: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };

function summary(over: Partial<EntrySummary> = {}): EntrySummary {
  return {
    id: 'r1', deviceId: 'd1', source: 'atlantis', startedAt: 1, method: 'GET', url: 'https://api.test/x',
    status: 200, durationMs: 1, error: null, requestBody: bodyRef, responseBody: bodyRef, ...over,
  };
}

function snapshot(): SnapshotMessage {
  return {
    type: 'snapshot', devices: [], entries: { items: [], nextCursor: null }, ws: { items: [], nextCursor: null },
    retention: null, atMax: false, truncated: false, paused: false,
  };
}

describe('Store', () => {
  it('folds a snapshot then an entry into one entry', () => {
    const store = new Store();
    store.apply([snapshot(), { type: 'entry', entry: summary() }]);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0].id).toBe('r1');
  });

  it('notifies onApplied listeners with the batch and stops after unsubscribe', () => {
    const store = new Store();
    const seen: unknown[] = [];
    const off = store.onApplied((b) => seen.push(b));
    const batch = [snapshot()];
    store.apply(batch);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(batch);
    off();
    store.apply([snapshot()]);
    expect(seen).toHaveLength(1);
  });

  it('forwards paused deltas to onPaused and keeps them out of the fold', () => {
    const store = new Store();
    let paused = false;
    store.onPaused = (p) => { paused = p; };
    store.apply([{ type: 'paused', paused: true }]);
    expect(paused).toBe(true);
    expect(store.entries).toHaveLength(0);
  });

  it('reset clears the folded state', () => {
    const store = new Store();
    store.apply([snapshot(), { type: 'entry', entry: summary() }]);
    store.reset();
    expect(store.entries).toHaveLength(0);
    expect(store.arrivals).toBe(0);
  });

  it('arrivals counts a key once — dup in a batch and a later update are +0', () => {
    const store = new Store();
    // Same key twice in one batch (addEntry then patchEntryResponse) → +1.
    store.apply([{ type: 'entry', entry: summary({ id: 'a' }) }, { type: 'entry', entry: summary({ id: 'a', status: 200 }) }]);
    expect(store.arrivals).toBe(1);
    // A key already present, updated in a later batch → +0.
    store.apply([{ type: 'entry', entry: summary({ id: 'a', status: 404 }) }]);
    expect(store.arrivals).toBe(1);
    // Two different new keys → +2.
    store.apply([{ type: 'entry', entry: summary({ id: 'b' }) }, { type: 'entry', entry: summary({ id: 'c' }) }]);
    expect(store.arrivals).toBe(3);
  });

  it('arrivals ignores eviction and resets to zero on a snapshot resync', () => {
    const store = new Store();
    store.apply([{ type: 'entry', entry: summary({ id: 'a' }) }, { type: 'entry', entry: summary({ id: 'b' }) }]);
    expect(store.arrivals).toBe(2);
    store.apply([{ type: 'entries_removed', keys: [{ deviceId: 'd1', id: 'a' }] }]);
    expect(store.arrivals).toBe(2); // eviction is not an arrival
    // Snapshot = resync, not arrivals: the pill baseline drops to zero.
    store.apply([{ ...snapshot(), entries: { items: [summary({ id: 'x' }), summary({ id: 'y' })], nextCursor: null } }]);
    expect(store.arrivals).toBe(0);
  });

  it('arrivals: a global clear zeroes, a device-scoped clear leaves it', () => {
    const store = new Store();
    store.apply([{ type: 'entry', entry: summary({ id: 'a' }) }, { type: 'entry', entry: summary({ id: 'b' }) }]);
    expect(store.arrivals).toBe(2);
    store.apply([{ type: 'clear', deviceId: 'd1' }]); // device-scoped: cosmetic stale count kept
    expect(store.arrivals).toBe(2);
    store.apply([{ type: 'clear', deviceId: null }]); // global: zeroed
    expect(store.arrivals).toBe(0);
  });

  it('arrivals stays monotone past the retention cap (2100 > MAX_ENTRIES 2000)', () => {
    const store = new Store();
    const batch = Array.from({ length: 2100 }, (_, i) => ({ type: 'entry' as const, entry: summary({ id: `r${i}` }) }));
    store.apply(batch);
    expect(store.arrivals).toBe(2100);
    expect(store.entries).toHaveLength(2000);
  });

  it('arrivalsByDevice counts new arrivals per device (dup/update are +0)', () => {
    const store = new Store();
    store.apply([
      { type: 'entry', entry: summary({ id: 'a', deviceId: 'd1' }) },
      { type: 'entry', entry: summary({ id: 'a', deviceId: 'd1', status: 200 }) }, // dup in batch
      { type: 'entry', entry: summary({ id: 'b', deviceId: 'd2' }) },
    ]);
    expect(store.arrivalsByDevice.get('d1')).toBe(1);
    expect(store.arrivalsByDevice.get('d2')).toBe(1);
    // A later update to an existing key does not bump its device.
    store.apply([{ type: 'entry', entry: summary({ id: 'a', deviceId: 'd1', status: 404 }) }]);
    expect(store.arrivalsByDevice.get('d1')).toBe(1);
    // A fresh key on d2 bumps only d2.
    store.apply([{ type: 'entry', entry: summary({ id: 'c', deviceId: 'd2' }) }]);
    expect(store.arrivalsByDevice.get('d2')).toBe(2);
    expect(store.arrivalsByDevice.get('d1')).toBe(1);
  });

  it('arrivalsByDevice clears on a snapshot resync, a global clear, and reset', () => {
    const store = new Store();
    const seed = () => store.apply([
      { type: 'entry', entry: summary({ id: 'a', deviceId: 'd1' }) },
      { type: 'entry', entry: summary({ id: 'b', deviceId: 'd2' }) },
    ]);
    seed();
    expect(store.arrivalsByDevice.get('d2')).toBe(1);
    // Snapshot resync zeroes the per-device backlog alongside the total.
    store.apply([snapshot()]);
    expect(store.arrivalsByDevice.get('d1')).toBeUndefined();
    expect(store.arrivalsByDevice.get('d2')).toBeUndefined();
    // A device-scoped clear leaves the (cosmetic) per-device count, matching `arrivals`.
    seed();
    store.apply([{ type: 'clear', deviceId: 'd1' }]);
    expect(store.arrivalsByDevice.get('d2')).toBe(1);
    // A global clear zeroes it.
    store.apply([{ type: 'clear', deviceId: null }]);
    expect(store.arrivalsByDevice.get('d1')).toBeUndefined();
    expect(store.arrivalsByDevice.get('d2')).toBeUndefined();
    // reset() clears it too.
    seed();
    store.reset();
    expect(store.arrivalsByDevice.size).toBe(0);
  });
});
