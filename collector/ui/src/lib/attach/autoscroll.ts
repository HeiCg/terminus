import type { Attachment } from 'svelte/attachments';

const NEAR = 8; // px tolerance for "the user is parked at the newest edge"

type Edge = 'top' | 'bottom';
type Anchored = HTMLElement & { __asVersion?: number; __asPending?: number };

// Where the newest rows land: bottom-anchored under an ascending time sort, but
// top-anchored under the default `time desc`. The caller passes the edge; this
// attachment only knows "am I near it" and "put me at it".
const nearEdge = (el: HTMLElement, edge: Edge): boolean =>
  edge === 'bottom'
    ? el.scrollHeight - el.clientHeight - el.scrollTop <= NEAR
    : el.scrollTop <= NEAR;

const stick = (el: HTMLElement, edge: Edge): void => {
  el.scrollTo?.({ top: edge === 'bottom' ? el.scrollHeight : 0 });
};

// Keeps a scroll container pinned to the edge where new rows arrive, and counts
// the rows that landed while the user had scrolled away from it.
//
// `version` is the arrival counter the caller bumps per captured row (the Store's
// entry count, NOT the filtered row count — filtering must not read as arrival).
// Reading it here means `{@attach autoscroll({ version, ... })}` re-runs whenever
// it changes; the accumulator lives on the element (which outlives each re-run)
// rather than in a closure the re-creation would reset.
//
// - version increases while near the edge → stick to it, report `onAttached`.
// - version increases while away → add the delta to a pending count, report
//   `onDetached(pending)` so the caller shows a "N new" pill.
// - version DECREASES (a Clear shrank the list) → drop the backlog, `onAttached`.
// - first mount (no prior version) → sync the caller to zero via `onAttached`, so
//   re-mounting the container (the caller keys it on the filter/sort signature)
//   clears the pill.
// A manual scroll back to the edge also clears the pending count. The caller
// scrolls to the edge on the pill click via `element.scrollTo`.
export function autoscroll(opts: {
  edge: Edge;
  version: number;
  onDetached: (pendingNew: number) => void;
  onAttached: () => void;
}): Attachment {
  return (element) => {
    const el = element as Anchored;
    const prev = el.__asVersion;
    el.__asVersion = opts.version;

    if (prev === undefined || opts.version < prev) {
      el.__asPending = 0;
      opts.onAttached();
    } else if (opts.version > prev) {
      const delta = opts.version - prev;
      if (nearEdge(el, opts.edge)) {
        el.__asPending = 0;
        stick(el, opts.edge);
        opts.onAttached();
      } else {
        el.__asPending = (el.__asPending ?? 0) + delta;
        opts.onDetached(el.__asPending);
      }
    }

    const onScroll = (): void => {
      if (nearEdge(el, opts.edge) && (el.__asPending ?? 0) > 0) {
        el.__asPending = 0;
        opts.onAttached();
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  };
}
