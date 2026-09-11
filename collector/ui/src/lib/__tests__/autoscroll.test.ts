import { describe, it, expect, vi } from 'vitest';
import { autoscroll } from '../attach/autoscroll.js';

// A jsdom element with a controllable layout box; scrollTo is spied so we can
// assert the stick target. scrollTop is writable so tests can move it.
function fakeEl(opts: { clientHeight: number; scrollHeight: number; scrollTop: number }): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => opts.clientHeight });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => opts.scrollHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: opts.scrollTop });
  el.scrollTo = vi.fn();
  return el;
}

// Re-attach with a new version, mirroring how Svelte re-runs the attachment when
// `version` changes (the accumulator persists on the element across re-runs).
function bump(el: HTMLElement, version: number, edge: 'top' | 'bottom' | null, cbs: { onDetached: (n: number) => void; onAttached: () => void }): void {
  autoscroll({ edge, version, ...cbs })(el);
}

describe('autoscroll', () => {
  it('(a) near the bottom edge, a new version sticks to it with pending 0', () => {
    const el = fakeEl({ clientHeight: 100, scrollHeight: 200, scrollTop: 100 }); // exactly at bottom
    const onDetached = vi.fn();
    const onAttached = vi.fn();
    bump(el, 0, 'bottom', { onDetached, onAttached }); // mount
    bump(el, 1, 'bottom', { onDetached, onAttached }); // arrival
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 200 });
    expect(onDetached).not.toHaveBeenCalled();
  });

  it('(b) away from the edge, three arrivals report onDetached(3)', () => {
    const el = fakeEl({ clientHeight: 100, scrollHeight: 200, scrollTop: 0 }); // far from bottom
    const onDetached = vi.fn();
    const onAttached = vi.fn();
    bump(el, 0, 'bottom', { onDetached, onAttached }); // mount
    bump(el, 1, 'bottom', { onDetached, onAttached });
    bump(el, 2, 'bottom', { onDetached, onAttached });
    bump(el, 3, 'bottom', { onDetached, onAttached });
    expect(onDetached.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
    expect(el.scrollTo).not.toHaveBeenCalled();
  });

  it('(c) a version decrease resets the pending backlog', () => {
    const el = fakeEl({ clientHeight: 100, scrollHeight: 200, scrollTop: 0 });
    const onDetached = vi.fn();
    const onAttached = vi.fn();
    bump(el, 0, 'bottom', { onDetached, onAttached });
    bump(el, 3, 'bottom', { onDetached, onAttached }); // pending 3
    expect(onDetached).toHaveBeenLastCalledWith(3);
    bump(el, 1, 'bottom', { onDetached, onAttached }); // Clear: version dropped → reset
    expect(onAttached).toHaveBeenCalled();
    bump(el, 2, 'bottom', { onDetached, onAttached }); // next arrival starts fresh
    expect(onDetached).toHaveBeenLastCalledWith(1);
  });

  it('(d) top edge: near = scrollTop <= 8, else pending accrues', () => {
    const near = fakeEl({ clientHeight: 100, scrollHeight: 200, scrollTop: 0 });
    const onDetachedN = vi.fn();
    const onAttachedN = vi.fn();
    bump(near, 0, 'top', { onDetached: onDetachedN, onAttached: onAttachedN });
    bump(near, 1, 'top', { onDetached: onDetachedN, onAttached: onAttachedN });
    expect(near.scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(onDetachedN).not.toHaveBeenCalled();

    const away = fakeEl({ clientHeight: 100, scrollHeight: 200, scrollTop: 100 });
    const onDetachedA = vi.fn();
    const onAttachedA = vi.fn();
    bump(away, 0, 'top', { onDetached: onDetachedA, onAttached: onAttachedA });
    bump(away, 1, 'top', { onDetached: onDetachedA, onAttached: onAttachedA });
    expect(onDetachedA).toHaveBeenCalledWith(1);
    expect(away.scrollTo).not.toHaveBeenCalled();
  });

  it('(e) null edge (non-time sort): every arrival accrues, position ignored', () => {
    // Parked AT the top, which under a time sort would stick; with no edge there
    // is nothing to stick to, so each arrival still counts toward the pill.
    const el = fakeEl({ clientHeight: 100, scrollHeight: 200, scrollTop: 0 });
    const onDetached = vi.fn();
    const onAttached = vi.fn();
    bump(el, 0, null, { onDetached, onAttached }); // mount → onAttached, pending 0
    bump(el, 1, null, { onDetached, onAttached });
    bump(el, 3, null, { onDetached, onAttached }); // +2
    expect(onDetached.mock.calls.map((c) => c[0])).toEqual([1, 3]);
    expect(el.scrollTo).not.toHaveBeenCalled();
  });

  it('(f) null edge: a scroll to the edge does NOT clear the backlog', () => {
    const el = fakeEl({ clientHeight: 100, scrollHeight: 200, scrollTop: 100 });
    const onDetached = vi.fn();
    const onAttached = vi.fn();
    bump(el, 0, null, { onDetached, onAttached });
    bump(el, 2, null, { onDetached, onAttached });
    expect(onDetached).toHaveBeenLastCalledWith(2);
    onAttached.mockClear();
    (el as unknown as { scrollTop: number }).scrollTop = 0;
    el.dispatchEvent(new Event('scroll')); // no listener registered under null edge
    expect(onAttached).not.toHaveBeenCalled();
  });

  it('a manual scroll back to the edge clears the pending count', () => {
    const el = fakeEl({ clientHeight: 100, scrollHeight: 200, scrollTop: 0 });
    const onDetached = vi.fn();
    const onAttached = vi.fn();
    bump(el, 0, 'bottom', { onDetached, onAttached });
    bump(el, 2, 'bottom', { onDetached, onAttached }); // pending 2 while away
    expect(onDetached).toHaveBeenLastCalledWith(2);
    onAttached.mockClear();
    (el as unknown as { scrollTop: number }).scrollTop = 100; // user scrolls to bottom
    el.dispatchEvent(new Event('scroll'));
    expect(onAttached).toHaveBeenCalled();
  });
});
