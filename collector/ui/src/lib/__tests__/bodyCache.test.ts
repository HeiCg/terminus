import { describe, it, expect } from 'vitest';
import { BodyCache } from '../bodyCache.js';
import { utf8Bytes } from '../format.js';

describe('utf8Bytes', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(utf8Bytes('abc')).toBe(3); // ASCII: bytes == units
    expect(utf8Bytes('€')).toBe(3); // one BMP char, 3 bytes, length 1
    expect(utf8Bytes('𝟙')).toBe(4); // astral char, 4 bytes, length 2
  });
});

describe('BodyCache byte accounting', () => {
  it('bills a body by its real UTF-8 size, not string.length', () => {
    const cache = new BodyCache();
    const multibyte = '€'.repeat(10); // length 10 (UTF-16), 30 bytes (UTF-8)
    cache.putRaw('mb', multibyte);
    expect(cache.retainedBytes).toBe(30);
    expect(cache.retainedBytes).not.toBe(multibyte.length);
  });

  it('evicts using the real byte budget for multibyte bodies', () => {
    // Budget of 30 bytes: two 30-byte multibyte bodies cannot both fit, so the
    // oldest is evicted. Under UTF-16 accounting (length 10) both would fit and
    // nothing would be evicted — this asserts the byte-based cap.
    const cache = new BodyCache(30);
    cache.putRaw('a', '€'.repeat(10));
    cache.putRaw('b', '€'.repeat(10));
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.retainedBytes).toBe(30);
  });
});
