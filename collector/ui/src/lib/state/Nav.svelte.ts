import { updateHashParams } from '../hash.js';

// Nav owns the current top-level view and mirrors it into the history hash so a
// reload (or a back/forward) lands on the same tab. The hash is a querystring
// shared with the Capture filters (T6.3): the view lives under `view=`, written
// through the shared hash helper so a filter change never drops it and a view
// change never drops the filters. `fromLocation` reads that key back, defaulting
// to `capture` for a missing or unknown value (the boot token fragment included,
// which Session strips before this ever runs).
export type View = 'capture' | 'sockets' | 'devices' | 'settings';

const VIEWS: readonly View[] = ['capture', 'sockets', 'devices', 'settings'];

export class Nav {
  view = $state<View>('capture');

  go(v: View): void {
    this.view = v;
    // pushState (not replace): switching tabs earns a history entry, so Back walks
    // views. Preserve the filter keys already in the hash.
    updateHashParams((p) => p.set('view', v), { push: true });
  }

  static fromLocation(loc: Location): View {
    const raw = loc.hash.replace(/^#/, '');
    // `view=` param first; fall back to a bare fragment (`#capture`) for legacy
    // links written before the hash became a querystring.
    const h = new URLSearchParams(raw).get('view') ?? raw;
    return (VIEWS as readonly string[]).includes(h) ? (h as View) : 'capture';
  }
}
