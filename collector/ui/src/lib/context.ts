import { getContext } from 'svelte';
import type { Store } from './state/Store.svelte.js';
import type { Session } from './state/Session.svelte.js';
import type { Nav } from './state/Nav.svelte.js';
import type { Clock } from './state/Clock.svelte.js';
import type { BodyCache } from './bodyCache.js';
import type { Filters } from './state/Filters.svelte.js';
import type { Selection } from './state/Selection.svelte.js';
import type { Sockets } from './state/Sockets.svelte.js';

// One symbol per singleton, so components pull exactly what they need from
// context instead of prop-drilling the runtime through every layer. `provide` is
// called once in the App shell's init; the `use*` helpers read it back with the
// concrete type. `client` has a symbol reserved but is not context-provided in
// this task (only main.ts and the shell drive it). Filters/Selection/Sockets are
// app-lifetime view state (created once in main.ts), so a tab switch preserves
// chips, search, sort, selection, detail cache, selected socket and loaded frames.
export const CTX = {
  store: Symbol('store'),
  session: Symbol('session'),
  client: Symbol('client'),
  nav: Symbol('nav'),
  clock: Symbol('clock'),
  cache: Symbol('cache'),
  filters: Symbol('filters'),
  selection: Symbol('selection'),
  sockets: Symbol('sockets'),
} as const;

export type Runtime = {
  store: Store; session: Session; nav: Nav; clock: Clock; cache: BodyCache;
  filters: Filters; selection: Selection; sockets: Sockets;
};

// The runtime bindings as a Map, for seeding the ROOT context at `mount(App, {
// context })`. The singletons are created outside any component (in main.ts), so
// injecting them at the mount boundary is the single source of truth — the shell
// never reads init props into setContext (which Svelte flags as an
// initial-value-only capture).
export function rootContext(rt: Runtime): Map<symbol, unknown> {
  return new Map<symbol, unknown>([
    [CTX.store, rt.store],
    [CTX.session, rt.session],
    [CTX.nav, rt.nav],
    [CTX.clock, rt.clock],
    [CTX.cache, rt.cache],
    [CTX.filters, rt.filters],
    [CTX.selection, rt.selection],
    [CTX.sockets, rt.sockets],
  ]);
}

export const useStore = (): Store => getContext(CTX.store);
export const useSession = (): Session => getContext(CTX.session);
export const useNav = (): Nav => getContext(CTX.nav);
export const useClock = (): Clock => getContext(CTX.clock);
export const useCache = (): BodyCache => getContext(CTX.cache);
export const useFilters = (): Filters => getContext(CTX.filters);
export const useSelection = (): Selection => getContext(CTX.selection);
export const useSockets = (): Sockets => getContext(CTX.sockets);
