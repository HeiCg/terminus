// Nav owns the current top-level view and mirrors it into the history hash so a
// reload (or a back/forward) lands on the same tab. `fromLocation` reads that
// hash back, defaulting to `capture` for an empty or unknown fragment (the boot
// token fragment included, which Session strips before this ever runs).
export type View = 'capture' | 'sockets' | 'devices' | 'settings';

const VIEWS: readonly View[] = ['capture', 'sockets', 'devices', 'settings'];

export class Nav {
  view = $state<View>('capture');

  go(v: View): void {
    this.view = v;
    history.pushState({ view: v }, '', `#${v}`);
  }

  static fromLocation(loc: Location): View {
    const h = loc.hash.replace(/^#/, '');
    return (VIEWS as readonly string[]).includes(h) ? (h as View) : 'capture';
  }
}
