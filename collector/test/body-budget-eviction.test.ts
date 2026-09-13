import { describe, it, expect } from 'vitest';
import { Store } from '../src/store.js';
import type { EntryInput } from '../src/types.js';

const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

const input = (id: string, deviceId: string, over: Partial<EntryInput> = {}): EntryInput => ({
  id, deviceId, source: 'atlantis', startedAt: 1, method: 'GET', url: `https://x/${id}`,
  requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
  status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: null, responseBodySize: 0,
  responseBodyOmitted: null, durationMs: 1, error: null, ...over,
});

const ids = (s: Store, d: string): string[] => s.entries(d).map((e) => e.id);
const body = (s: Store, d: string, id: string): string | null => s.entries(d).find((e) => e.id === id)?.responseBody ?? null;

// T1.1: when a new body does not fit the shared body budget, the store evicts
// oldest retained entries to free room and captures the body, instead of dropping
// it as omitted:'budget' forever — while a blob larger than the whole budget and a
// retention floor both bound how far that eviction goes.
describe('body-budget eviction (T1.1)', () => {
  it('evicts the oldest entry to make room for a newer body, then captures it', () => {
    // budget 20 B holds two 8-B bodies; the third forces one eviction.
    const s = new Store({ limits: { bodyBytes: 20, bodyEvictionFloor: 1, perBodyBytes: 100 } });
    s.addEntryInput(input('e1', 'd1', { responseBytes: bytes('aaaaaaaa'), responseBodySize: 8 }));
    s.addEntryInput(input('e2', 'd1', { responseBytes: bytes('bbbbbbbb'), responseBodySize: 8 }));
    s.addEntryInput(input('e3', 'd1', { responseBytes: bytes('cccccccc'), responseBodySize: 8 }));

    // The oldest entry was evicted; the newest body was captured, not omitted.
    expect(ids(s, 'd1')).not.toContain('e1');
    expect(ids(s, 'd1')).toContain('e3');
    expect(body(s, 'd1', 'e3')).toBe('cccccccc');
    expect(s.entries('d1').find((e) => e.id === 'e3')!.responseBodyOmitted).toBeNull();
    expect(s.bodyStats().retainedBytes).toBeLessThanOrEqual(20);
    // (d) the dedicated counter increments once per budget eviction.
    expect(s.retentionCounters().evictedForBodyBudget).toBe(1);
  });

  it('keeps omitted:budget for a blob larger than the whole budget, evicting nothing', () => {
    const s = new Store({ limits: { bodyBytes: 20, bodyEvictionFloor: 1, perBodyBytes: 100 } });
    s.addEntryInput(input('e1', 'd1', { responseBytes: bytes('aaaaaaaa'), responseBodySize: 8 }));
    // 30 B > the entire 20 B budget: eviction can never make it fit.
    s.addEntryInput(input('e2', 'd1', { responseBytes: bytes('x'.repeat(30)), responseBodySize: 30 }));

    const e2 = s.entries('d1').find((e) => e.id === 'e2')!;
    expect(e2.responseBody).toBeNull();
    expect(e2.responseBodyOmitted).toBe('budget');
    // Nothing was evicted to chase an impossible fit: the older entry survives.
    expect(ids(s, 'd1')).toContain('e1');
    expect(body(s, 'd1', 'e1')).toBe('aaaaaaaa');
    expect(s.retentionCounters().evictedForBodyBudget).toBe(0);
  });

  it('never evicts below the retention floor, leaving the new body omitted:budget', () => {
    // Three DISTINCT 8-B bodies fill the 24 B budget and sit exactly at the floor of
    // 3 (distinct so the content-addressed store retains three blobs, not one).
    const s = new Store({ limits: { bodyBytes: 24, bodyEvictionFloor: 3, perBodyBytes: 100 } });
    const payloads: Record<string, string> = { e1: 'aaaaaaaa', e2: 'bbbbbbbb', e3: 'cccccccc' };
    for (const id of ['e1', 'e2', 'e3']) {
      s.addEntryInput(input(id, 'd1', { responseBytes: bytes(payloads[id]), responseBodySize: 8 }));
    }
    s.addEntryInput(input('e4', 'd1', { responseBytes: bytes('dddddddd'), responseBodySize: 8 }));

    // The 4th body cannot evict below the floor, so it stays omitted; the entry
    // itself is still admitted (only its body was dropped).
    const e4 = s.entries('d1').find((e) => e.id === 'e4')!;
    expect(e4.responseBody).toBeNull();
    expect(e4.responseBodyOmitted).toBe('budget');
    expect(s.retentionCounters().evictedForBodyBudget).toBe(0);
    // All three originals are retained, none evicted.
    expect(ids(s, 'd1').sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(s.bodyStats().retainedBytes).toBe(24);
  });

  it('evicts several oldest entries when one large body needs the room', () => {
    // budget 40 B; four DISTINCT 8-B bodies fill 32; a 24-B body needs two evictions.
    const s = new Store({ limits: { bodyBytes: 40, bodyEvictionFloor: 1, perBodyBytes: 100 } });
    const payloads: Record<string, string> = { e1: 'aaaaaaaa', e2: 'bbbbbbbb', e3: 'cccccccc', e4: 'dddddddd' };
    for (const id of ['e1', 'e2', 'e3', 'e4']) {
      s.addEntryInput(input(id, 'd1', { responseBytes: bytes(payloads[id]), responseBodySize: 8 }));
    }
    s.addEntryInput(input('big', 'd1', { responseBytes: bytes('y'.repeat(24)), responseBodySize: 24 }));

    expect(body(s, 'd1', 'big')).toBe('y'.repeat(24));
    // Oldest two evicted (e1, e2); e3, e4 and big retained: 8 + 8 + 24 = 40.
    expect(ids(s, 'd1')).not.toContain('e1');
    expect(ids(s, 'd1')).not.toContain('e2');
    expect(ids(s, 'd1')).toEqual(expect.arrayContaining(['e3', 'e4', 'big']));
    expect(s.retentionCounters().evictedForBodyBudget).toBe(2);
    expect(s.bodyStats().retainedBytes).toBeLessThanOrEqual(40);
  });
});
