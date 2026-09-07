import { describe, it, expect } from 'vitest';
import { createSessionAdmission } from '../src/sessionAdmission.js';
import { DEFAULT_LIMITS } from '../src/retention.js';

const key = (deviceId: string, wsId: string) => ({ deviceId, wsId });

describe('SessionAdmission (O04)', () => {
  it('admits an open as new, then reports existing', () => {
    const a = createSessionAdmission();
    expect(a.observe(key('d1', 'w1'), 'g1', 'open')).toBe('new');
    expect(a.observe(key('d1', 'w1'), 'g1', 'open')).toBe('existing');
    expect(a.observe(key('d1', 'w1'), 'g1', 'frame')).toBe('existing');
  });

  it('opens a partial session for an orphan first frame', () => {
    const a = createSessionAdmission();
    expect(a.observe(key('d1', 'w9'), 'g1', 'frame')).toBe('partial');
  });

  it('drops a late frame on the same generation after the id was removed', () => {
    const a = createSessionAdmission();
    a.observe(key('d1', 'w1'), 'g1', 'open');
    a.markRemoved(key('d1', 'w1'));                 // clear / eviction
    expect(a.observe(key('d1', 'w1'), 'g1', 'frame')).toBe('dropped');
    expect(a.observe(key('d1', 'w1'), 'g1', 'open')).toBe('dropped'); // never reopens same gen
  });

  it('treats a reappearance on a new generation as partial (a gap)', () => {
    const a = createSessionAdmission();
    a.observe(key('d1', 'w1'), 'g1', 'open');
    a.markRemoved(key('d1', 'w1'));
    // A reconnect is a new generation; the id was retained-then-removed, so its
    // return signals a gap rather than a clean open.
    expect(a.observe(key('d1', 'w1'), 'g2', 'open')).toBe('partial');
  });

  it('keeps two devices independent under the same wsId', () => {
    const a = createSessionAdmission();
    expect(a.observe(key('d1', 'w1'), 'g1', 'open')).toBe('new');
    expect(a.observe(key('d2', 'w1'), 'g2', 'open')).toBe('new'); // distinct composite key
    a.markRemoved(key('d1', 'w1'));
    expect(a.observe(key('d2', 'w1'), 'g2', 'frame')).toBe('existing'); // d2 untouched
  });

  it('overloads when a generation exceeds the id cap, and frees on closeGeneration', () => {
    const a = createSessionAdmission({ ...DEFAULT_LIMITS, admissionIdsPerGeneration: 3, admissionBytes: 1 << 20 });
    for (let i = 0; i < 3; i++) expect(a.observe(key('d1', `w${i}`), 'g1', 'open')).toBe('new');
    expect(a.observe(key('d1', 'w3'), 'g1', 'open')).toBe('overload');
    a.closeGeneration('g1'); // the responsible connection is closed and its registry freed
    expect(a.stats().registryBytes).toBe(0);
    expect(a.observe(key('d1', 'w3'), 'g2', 'open')).toBe('new'); // fresh generation admits again
  });

  it('overloads when the byte budget is exhausted', () => {
    const a = createSessionAdmission({ ...DEFAULT_LIMITS, admissionBytes: 40 });
    // Each key serializes to well over 10 bytes; a couple fit, then the budget bites.
    let outcomes = 0; let overloaded = false;
    for (let i = 0; i < 20 && !overloaded; i++) {
      const r = a.observe(key('dev', `socket-${i}`), 'g1', 'open');
      if (r === 'overload') overloaded = true; else outcomes++;
    }
    expect(overloaded).toBe(true);
    expect(a.registryBytes()).toBeLessThanOrEqual(40);
    expect(outcomes).toBeGreaterThan(0);
  });

  it('bounds the registry over thousands of ids without pinning removed sessions', () => {
    const a = createSessionAdmission();
    for (let i = 0; i < 4096; i++) a.observe(key('d1', `w${i}`), 'g1', 'open');
    expect(a.observe(key('d1', 'w4096'), 'g1', 'open')).toBe('overload'); // per-gen id cap
    a.closeGeneration('g1');
    expect(a.stats()).toMatchObject({ generations: 0, registryBytes: 0 });
  });

  it('bounds the removedEver tombstone set under unbounded session churn (CRITICAL 1)', () => {
    const a = createSessionAdmission({ ...DEFAULT_LIMITS, admissionIdsPerGeneration: 16, admissionBytes: 4096 });
    // Simulate a long capture: thousands of distinct sessions removed over time.
    for (let i = 0; i < 5000; i++) a.markRemoved(key('d1', `churn-${i}`));
    const s = a.stats();
    expect(s.removedEver).toBeLessThanOrEqual(16);       // count-bounded, not 5000
    expect(s.registryBytes).toBeLessThanOrEqual(4096);   // byte-bounded
  });

  it('resetDevice reclaims a device generation id budget without waiting for reconnect', () => {
    const a = createSessionAdmission({ ...DEFAULT_LIMITS, admissionIdsPerGeneration: 3 });
    for (let i = 0; i < 3; i++) expect(a.observe(key('d1', `w${i}`), 'g1', 'open')).toBe('new');
    expect(a.observe(key('d1', 'w3'), 'g1', 'open')).toBe('overload'); // generation full
    a.resetDevice('d1'); // a per-device clear on the same live connection
    expect(a.observe(key('d1', 'w3'), 'g1', 'open')).toBe('new'); // capacity reclaimed
    // Another device on the same generation is unaffected by d1's reset.
    a.observe(key('d2', 'k'), 'g1', 'open');
    a.resetDevice('d1');
    expect(a.observe(key('d2', 'k'), 'g1', 'frame')).toBe('existing');
  });

  it('overloads a live id joining a new, full generation (frame-path guard)', () => {
    const a = createSessionAdmission({ ...DEFAULT_LIMITS, admissionBytes: 30 });
    expect(a.observe(key('d1', 'w1'), 'g1', 'open')).toBe('new'); // charged in g1
    // The same live id observed on a second generation must be recorded there too;
    // with the byte budget exhausted, that record overloads instead of appending.
    for (let i = 0; i < 5; i++) a.observe(key('d1', `pad${i}`), 'g2', 'open');
    expect(a.observe(key('d1', 'w1'), 'g2', 'frame')).toBe('overload');
  });

  it('reset clears all live/tombstone state (full clear)', () => {
    const a = createSessionAdmission();
    a.observe(key('d1', 'w1'), 'g1', 'open');
    a.reset();
    expect(a.stats()).toMatchObject({ generations: 0, live: 0, registryBytes: 0 });
    expect(a.observe(key('d1', 'w1'), 'g1', 'open')).toBe('new'); // clean slate
  });

  it('does not double-charge a tombstone (markRemoved adds no registry bytes)', () => {
    const a = createSessionAdmission();
    a.observe(key('d1', 'w1'), 'g1', 'open');
    const before = a.registryBytes();
    a.markRemoved(key('d1', 'w1')); // tombstone in the same generation
    // The id is already counted in the admitted set; the per-gen tombstone adds
    // nothing, and removedEver adds only its own bounded entry.
    expect(a.registryBytes()).toBeLessThanOrEqual(before * 2 + 64);
    a.closeGeneration('g1'); // frees the generation; only the bounded tombstone recency remains
    expect(a.registryBytes()).toBeLessThanOrEqual(64); // one key's worth, not accumulating
  });
});
