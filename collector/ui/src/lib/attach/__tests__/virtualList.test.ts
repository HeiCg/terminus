import { describe, it, expect, vi } from 'vitest';
import { virtualList, type Range } from '../virtualList.js';

// Give a jsdom element a layout box (jsdom does no layout, so these are 0 by
// default). virtualList reads scrollTop/clientHeight straight off the element.
function box(el: HTMLElement, clientHeight: number, scrollTop = 0): void {
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  el.scrollTop = scrollTop;
}

describe('virtualList', () => {
  it('windows a 2000-row list to a small range', () => {
    const el = document.createElement('div');
    box(el, 640);
    let range: Range | null = null;
    const cleanup = virtualList({ rowHeight: 32, overscan: 8, count: 2000, onRange: (r) => { range = r; } })(el);
    expect(range).not.toBeNull();
    const r = range!;
    expect(r.end - r.start).toBeLessThanOrEqual(60);
    expect(r.start).toBe(0);
    expect(r.padTop).toBe(0);
    expect(r.padBottom).toBe((2000 - r.end) * 32);
    cleanup?.();
  });

  it('recomputes on scroll and keeps the padding consistent', () => {
    const el = document.createElement('div');
    box(el, 640, 0);
    let range: Range | null = null;
    const cleanup = virtualList({ rowHeight: 32, overscan: 4, count: 1000, onRange: (r) => { range = r; } })(el);

    el.scrollTop = 3200; // 100 rows down
    el.dispatchEvent(new Event('scroll'));
    const r = range!;
    expect(r.start).toBe(100 - 4);
    expect(r.padTop).toBe(r.start * 32);
    expect(r.padTop + (r.end - r.start) * 32 + r.padBottom).toBe(1000 * 32);
    cleanup?.();
  });

  it('removes its listeners on cleanup', () => {
    const el = document.createElement('div');
    box(el, 320);
    const remove = vi.spyOn(el, 'removeEventListener');
    const cleanup = virtualList({ rowHeight: 32, overscan: 2, count: 10, onRange: () => {} })(el);
    cleanup?.();
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
