import { describe, it, expect, vi } from 'vitest';
import { BodyCache, BODY_CACHE_MAX_BYTES, PRETTY_MAX_OUTPUT } from '../ui/src/lib/bodyCache.js';

describe('BodyCache (O07 — bounded body cache, formatting by hash+mode)', () => {
  it('formats once per hash+mode and reuses it for a new ref with the same hash', () => {
    const c = new BodyCache();
    c.putRaw('h1', '{"b":2,"a":1}');
    const first = c.format('h1', 'json')!;
    const again = c.format('h1', 'json')!;
    expect(first.text).toContain('"b": 2');
    expect(again).toBe(first); // cached object: no re-parse

    // A different hash formats independently.
    c.putRaw('h2', '{"x":9}');
    expect(c.format('h2', 'json')!.text).not.toBe(first.text);
  });

  it('keeps raw for invalid JSON and warns', () => {
    const c = new BodyCache();
    c.putRaw('h', 'not json <html>');
    const f = c.format('h', 'json')!;
    expect(f.warning).toBe('invalid');
    expect(f.text).toBe('not json <html>');
  });

  it('falls back to raw with a warning when formatted output would exceed 1 MiB', () => {
    const c = new BodyCache(64 * 1024 * 1024);
    // A wide array whose pretty-printed form blows past PRETTY_MAX_OUTPUT.
    const big = JSON.stringify(Array.from({ length: 200_000 }, (_, i) => i));
    c.putRaw('big', big);
    const f = c.format('big', 'json')!;
    expect(f.warning).toBe('too-large');
    expect(f.text).toBe(big);            // raw shown, not a giant expanded string
    expect(f.text.length).toBeLessThan(PRETTY_MAX_OUTPUT + big.length + 1);
  });

  it('evicts LRU so retained bytes stay within budget, freeing all representations', () => {
    const c = new BodyCache(3000);
    for (let i = 0; i < 10; i++) c.putRaw(`h${i}`, 'x'.repeat(500));
    expect(c.retainedBytes).toBeLessThanOrEqual(3000);
    expect(c.has('h0')).toBe(false); // oldest evicted
    expect(c.has('h9')).toBe(true);  // newest kept

    // Formatting counts toward the budget (raw + pretty), and delete frees it all.
    const c2 = new BodyCache();
    c2.putRaw('j', JSON.stringify({ a: [1, 2, 3] }));
    const before = c2.retainedBytes;
    c2.format('j', 'json');
    expect(c2.retainedBytes).toBeGreaterThan(before);
    c2.delete('j');
    expect(c2.retainedBytes).toBe(0);
    expect(c2.has('j')).toBe(false);
  });

  it('a hash re-put does not double-count and touch marks it recently used', () => {
    const c = new BodyCache(1600); // room for four 400-byte nodes
    c.putRaw('a', 'x'.repeat(400));
    c.putRaw('b', 'x'.repeat(400));
    c.putRaw('a', 'x'.repeat(400)); // same hash again: no growth, 'a' now MRU
    expect(c.retainedBytes).toBe(800);
    c.putRaw('c', 'x'.repeat(400));
    c.putRaw('d', 'x'.repeat(400));
    c.putRaw('e', 'x'.repeat(400)); // 5th node overflows: evicts the LRU ('b'), not 'a'
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(c.retainedBytes).toBeLessThanOrEqual(1600);
  });

  it('counts the peekLower copy toward the budget so a scanned body cannot hold ~2x resident', () => {
    const c = new BodyCache(100);
    c.putRaw('h', 'ABCDE');
    expect(c.retainedBytes).toBe(5);
    expect(c.peekLower('h')).toBe('abcde');
    expect(c.retainedBytes).toBe(10);              // raw + lowercased both budgeted
    expect(c.retainedBytes).toBeLessThanOrEqual(100);
    // Memoized: a second read returns the same value and does not grow the budget.
    expect(c.peekLower('h')).toBe('abcde');
    expect(c.retainedBytes).toBe(10);
    // Deleting the node frees the lowercased copy too.
    c.delete('h');
    expect(c.retainedBytes).toBe(0);
  });

  it('skips a body whose lowercased copy exceeds 1/8 of the budget (not memoized, not returned)', () => {
    const c = new BodyCache(16);                    // max/8 = 2 bytes
    c.putRaw('h', 'ABCDEFGH');                      // 8-byte lowercased copy is over the cap
    expect(c.peekLower('h')).toBeUndefined();       // skipped — the palette falls back to url/headers
    expect(c.retainedBytes).toBe(8);                // lowercased copy not stored
    expect(c.retainedBytes).toBeLessThanOrEqual(16);
  });

  it('decides an oversized body once — never re-lowercases it per call', () => {
    const c = new BodyCache(16);                    // max/8 = 2 bytes
    c.putRaw('h', 'ABCDEFGH');
    const spy = vi.spyOn(String.prototype, 'toLowerCase');
    c.peekLower('h');                               // computes once, flags lowerTooBig
    c.peekLower('h');                               // short-circuits on the flag…
    c.peekLower('h');                               // …no recompute
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('exposes the 8 MiB default budget', () => {
    expect(BODY_CACHE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(new BodyCache().retainedBytes).toBe(0);
  });
});
