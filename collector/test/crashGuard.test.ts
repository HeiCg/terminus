import { describe, it, expect, vi } from 'vitest';
import { createCrashGuard } from '../src/crashGuard.js';

describe('createCrashGuard (T5.2)', () => {
  it('trips exactly at the threshold within the window, reporting the count', () => {
    const t = 1000;
    const onTrip = vi.fn();
    const g = createCrashGuard({ threshold: 3, windowMs: 60_000, now: () => t, onTrip });
    g.record(); g.record();
    expect(onTrip).not.toHaveBeenCalled();
    g.record();
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip).toHaveBeenCalledWith(3);
  });

  it('does not trip when crashes fall outside the window', () => {
    let t = 0;
    const onTrip = vi.fn();
    const g = createCrashGuard({ threshold: 3, windowMs: 1000, now: () => t, onTrip });
    g.record();            // t=0
    t = 2000; g.record();  // window cleared; only this one remains
    t = 2500; g.record();  // two within the last second
    expect(onTrip).not.toHaveBeenCalled();
  });

  it('trips at most once even as crashes keep arriving', () => {
    const t = 0;
    const onTrip = vi.fn();
    const g = createCrashGuard({ threshold: 2, now: () => t, onTrip });
    g.record(); g.record(); g.record(); g.record();
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it('clamps a threshold below 1 up to 1', () => {
    const onTrip = vi.fn();
    const g = createCrashGuard({ threshold: 0, onTrip });
    g.record();
    expect(onTrip).toHaveBeenCalledTimes(1);
  });
});
