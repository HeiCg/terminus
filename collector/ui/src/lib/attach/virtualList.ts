import type { Attachment } from 'svelte/attachments';

// The slice of a long row list that is actually mounted, plus the spacer heights
// that stand in for the rows above and below it so the scrollbar stays true to
// the full count.
export type Range = { start: number; end: number; padTop: number; padBottom: number };

// A windowing attachment for a fixed-row-height scroll container. It computes the
// visible range from the element's own scrollTop/clientHeight and reports it via
// `onRange` (the caller writes it into `$state`; this touches no reactive state
// itself, per the no-effect rule). It listens for scroll and resize and cleans
// both up on teardown.
//
// `count` is read at attach time, so `{@attach virtualList({ count, ... })}` is
// re-created whenever count changes — which also re-runs the initial `compute()`,
// keeping padBottom correct as rows arrive. rowHeight/overscan are stable.
export function virtualList(opts: {
  rowHeight: number;
  overscan: number;
  count: number;
  onRange: (r: Range) => void;
}): Attachment {
  return (element) => {
    const el = element as HTMLElement;
    const compute = (): void => {
      const { rowHeight, overscan, count } = opts;
      const first = Math.floor(el.scrollTop / rowHeight);
      const visible = Math.ceil(el.clientHeight / rowHeight);
      const start = Math.max(0, first - overscan);
      const end = Math.min(count, first + visible + overscan);
      opts.onRange({
        start,
        end,
        padTop: start * rowHeight,
        padBottom: Math.max(0, count - end) * rowHeight,
      });
    };
    compute();
    const onScroll = (): void => compute();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => compute());
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  };
}
