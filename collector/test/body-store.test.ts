import { describe, it, expect } from 'vitest';
import { createBodyStore } from '../src/bodyStore.js';

describe('createBodyStore', () => {
  // The exact dedup/refcount contract from the T08 brief.
  it('dedups identical blobs, counts references, frees at zero', () => {
    const bodies = createBodyStore({ maxBytes: 16 });
    const bytes = new Uint8Array([0, 255, 1]);
    const first = bodies.acquire(bytes)!;
    expect(bodies.acquire(bytes)).toBe(first);
    expect(bodies.stats()).toEqual({ retainedBytes: 3, blobCount: 1, references: 2 });
    bodies.release(first);
    expect(bodies.read(first)).toEqual(bytes);
    bodies.release(first);
    expect(bodies.stats().retainedBytes).toBe(0);
    expect(bodies.read(first)).toBeUndefined();
  });

  it('shares one blob across sources but a release only drops one reference', () => {
    const bodies = createBodyStore();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const a = bodies.acquire(bytes)!; // device A
    const b = bodies.acquire(bytes)!; // device B, identical capture
    expect(a).toBe(b);
    expect(bodies.stats().blobCount).toBe(1);
    bodies.release(a); // clear device A
    expect(bodies.read(b)).toEqual(bytes); // device B still holds it
    expect(bodies.stats().references).toBe(1);
  });

  it('refuses a new blob that would exceed the budget, but not an existing one', () => {
    const bodies = createBodyStore({ maxBytes: 4 });
    const small = bodies.acquire(new Uint8Array([1, 2, 3]))!;
    expect(small).not.toBeNull();
    // A second, different 3-byte blob would push retained to 6 > 4.
    expect(bodies.acquire(new Uint8Array([9, 9, 9, 9]))).toBeNull();
    // The already-retained blob still admits another reference (no new bytes).
    expect(bodies.acquire(new Uint8Array([1, 2, 3]))).toBe(small);
    expect(bodies.stats()).toMatchObject({ retainedBytes: 3, references: 2 });
  });

  it('owns an immutable copy detached from the caller buffer', () => {
    const bodies = createBodyStore();
    const backing = new Uint8Array([10, 20, 30, 40]);
    const view = backing.subarray(1, 3); // small slice of a larger buffer
    const h = bodies.acquire(view)!;
    backing.fill(0); // mutate the caller's backing allocation
    expect(bodies.read(h)).toEqual(new Uint8Array([20, 30]));
  });

  it('shares the empty-buffer hash for empty captured bodies', () => {
    const bodies = createBodyStore();
    const a = bodies.acquire(new Uint8Array([]))!;
    const b = bodies.acquire(new Uint8Array([]))!;
    expect(a).toBe(b);
    expect(bodies.stats()).toMatchObject({ retainedBytes: 0, blobCount: 1, references: 2 });
  });
});
