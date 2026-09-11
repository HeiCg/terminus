import { SvelteSet } from 'svelte/reactivity';
import type { Store } from './Store.svelte.js';
import type { EntrySummary } from '../protocol.js';
import { entityKey } from '../protocol.js';
import { splitUrl, statusBucket } from '../format.js';

// The type-chip filter (top row of the filter bar). `errors` is a synthetic
// bucket: any 4xx/5xx/transport-error row, regardless of kind.
export type TypeFilter = 'all' | 'xhr' | 'ws' | 'sse' | 'errors';
export type SortKey = 'status' | 'method' | 'host' | 'path' | 'size' | 'duration' | 'time';

// One HTTP row as the table consumes it: the summary plus the derived display
// fields (kind join, split host/path, status bucket, response size). `size` is
// the response body's original size, or null when unknown/absent.
export type Row = EntrySummary & {
  kind: 'xhr' | 'ws' | 'sse';
  host: string;
  path: string;
  bucket: ReturnType<typeof statusBucket>;
  size: number | null;
};

// `errors` covers client/server failures and transport errors — the buckets a
// developer scans for when something broke.
const ERROR_BUCKETS = new Set(['4xx', '5xx', 'error']);

// Filters is the Capture view's query state and the single place the entry list
// is shaped for the table. It reads the Store's `$derived` arrays, so every
// `$derived.by` here recomputes when a batch lands or a filter field changes —
// no effect required. The class owns nothing the Store owns; it only projects.
export class Filters {
  // Backing state for `device`; the accessor pair below rebaselines the
  // "other-device arrivals" counter whenever the selection changes (a plain field
  // assignment cannot, and reactive effects are banned). Reads stay reactive.
  #device = $state<string | 'all'>('all');
  get device(): string | 'all' { return this.#device; }
  set device(v: string | 'all') {
    this.#device = v;
    this.#rebaseline();
  }
  search = $state('');
  type = $state<TypeFilter>('all');
  statuses = new SvelteSet<'2xx' | '3xx' | '4xx' | '5xx'>();
  sources = new SvelteSet<'xhr' | 'atlantis' | 'proxy'>();
  host = $state<string | null>(null);
  hasBody = $state(false);
  sort = $state<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'time', dir: 'desc' });

  #store: Store;

  // Baseline for `otherDeviceNew`, captured whenever `device` changes: the total
  // arrival count and the count of arrivals NOT on the selected device, both taken
  // at selection time. Plain fields — the derived reacts to `#device` changing (a
  // $state) and to the Store's reactive counters, never to these.
  #baseTotal = 0;
  #baseOther = 0;

  // Memoized url split (host/path) per entityKey, so `new URL()` runs once per
  // entry, not once per entry per store batch. Keyed by entityKey and pinned to
  // the entry's url; a key whose entry has left the store is pruned on the next
  // #all pass, so the map evicts alongside the entries themselves. Plain (not
  // reactive): it is a pure cache the derived reads through, never a dependency.
  #urlMemo = new Map<string, { url: string; host: string; path: string }>();

  constructor(store: Store) {
    this.#store = store;
  }

  // Re-anchor the other-device counter to the store's current arrival totals, so
  // only arrivals AFTER this selection count. Called from the `device` setter.
  #rebaseline(): void {
    const total = this.#store.arrivals;
    const onSel = this.#device === 'all' ? total : this.#store.arrivalsByDevice.get(this.#device) ?? 0;
    this.#baseTotal = total;
    this.#baseOther = total - onSel;
  }

  // Arrivals that landed under a device OTHER than the selected one since the
  // selection (or the last snapshot resync). Zero when 'all' is selected — nothing
  // is then "elsewhere". Drives the Capture view's "N new on other devices" pill:
  // the trial's frozen-looking case where traffic streams in under an unselected
  // deviceId. When the store's counters reset below the baseline (a snapshot /
  // global clear), the baseline is treated as zero so the count starts fresh.
  otherDeviceNew = $derived.by((): number => {
    const d = this.#device;
    if (d === 'all') return 0;
    const total = this.#store.arrivals;
    const other = total - (this.#store.arrivalsByDevice.get(d) ?? 0);
    const base = total < this.#baseTotal ? 0 : this.#baseOther;
    const n = other - base;
    return n > 0 ? n : 0;
  });

  // Split an entry's url, reusing the memoized result unless the url for this key
  // changed (an entry's url is stable, so this is effectively parse-once).
  #splitFor(key: string, url: string): { host: string; path: string } {
    const hit = this.#urlMemo.get(key);
    if (hit && hit.url === url) return hit;
    const { host, path } = splitUrl(url);
    const entry = { url, host, path };
    this.#urlMemo.set(key, entry);
    return entry;
  }

  // entityKey(entry.deviceId, entry.id) → 'ws' | 'sse', for the entries a WS or
  // SSE session links back to via httpEntryKey. A plain socket has a null
  // httpEntryKey and marks no entry; an entry with no linking session stays xhr.
  #kinds = $derived.by((): Map<string, 'ws' | 'sse'> => {
    const m = new Map<string, 'ws' | 'sse'>();
    for (const w of this.#store.ws) {
      if (!w.httpEntryKey) continue;
      const k = entityKey(w.httpEntryKey.deviceId, w.httpEntryKey.id);
      if (w.kind === 'websocket') m.set(k, 'ws');
      else if (w.kind === 'sse') m.set(k, 'sse');
    }
    return m;
  });

  // Every entry projected to a Row, in the Store's insertion order (oldest first).
  // The filters/sort deriveds build on this so the kind join and url split happen
  // once per entry per batch.
  #all = $derived.by((): Row[] => {
    const kinds = this.#kinds;
    const live = new Set<string>();
    const rows = this.#store.entries.map((e): Row => {
      const key = entityKey(e.deviceId, e.id);
      live.add(key);
      const { host, path } = this.#splitFor(key, e.url);
      return {
        ...e,
        kind: kinds.get(key) ?? 'xhr',
        host,
        path,
        bucket: statusBucket(e.status, e.error),
        size: e.responseBody.size ?? null,
      };
    });
    // Evict memo entries whose row has left the store (clear or retention), so the
    // cache tracks the live entry set rather than growing without bound.
    if (this.#urlMemo.size > live.size) {
      for (const key of this.#urlMemo.keys()) if (!live.has(key)) this.#urlMemo.delete(key);
    }
    return rows;
  });

  // Rows in the current device scope only — the base for counts and the host
  // list, which the chips must show independent of the other active filters.
  #deviceRows = $derived.by((): Row[] => {
    const d = this.device;
    return d === 'all' ? this.#all : this.#all.filter((r) => r.deviceId === d);
  });

  // The device-scoped set with NO type/status/source/host/hasBody/search chip
  // applied — what the command palette searches, so an active filter chip never
  // hides a matching row from ⌘K. Sorted newest-first (startedAt desc) so the
  // palette's 50-item cap keeps the most recent traffic, not the oldest; the copy
  // is re-sorted once per store batch, never per keystroke. (`rows` applies the
  // chips and its own column sort; `allRows` applies neither.)
  allRows = $derived.by((): Row[] => [...this.#deviceRows].sort((a, b) => b.startedAt - a.startedAt));

  rows = $derived.by((): Row[] => {
    const q = this.search.trim().toLowerCase();
    const out = this.#deviceRows.filter((r) => {
      if (this.type === 'xhr' || this.type === 'ws' || this.type === 'sse') {
        if (r.kind !== this.type) return false;
      } else if (this.type === 'errors' && !ERROR_BUCKETS.has(r.bucket)) {
        return false;
      }
      if (this.statuses.size > 0 && !this.statuses.has(r.bucket as '2xx' | '3xx' | '4xx' | '5xx')) return false;
      if (this.sources.size > 0 && !this.sources.has(r.source)) return false;
      if (this.host !== null && r.host !== this.host) return false;
      if (this.hasBody && r.requestBody.state !== 'captured' && r.responseBody.state !== 'captured') return false;
      if (q && !r.url.toLowerCase().includes(q) && !r.method.toLowerCase().includes(q)) return false;
      return true;
    });
    return this.#sorted(out);
  });

  counts = $derived.by(() => {
    const rows = this.#deviceRows;
    let xhr = 0;
    let ws = 0;
    let sse = 0;
    let errors = 0;
    for (const r of rows) {
      if (r.kind === 'ws') ws += 1;
      else if (r.kind === 'sse') sse += 1;
      else xhr += 1;
      if (ERROR_BUCKETS.has(r.bucket)) errors += 1;
    }
    return { all: rows.length, xhr, ws, sse, errors };
  });

  hosts = $derived.by((): string[] => {
    const set = new Set<string>();
    for (const r of this.#deviceRows) if (r.host) set.add(r.host);
    return [...set].sort((a, b) => a.localeCompare(b));
  });

  toggleStatus(b: '2xx' | '3xx' | '4xx' | '5xx'): void {
    if (this.statuses.has(b)) this.statuses.delete(b);
    else this.statuses.add(b);
  }

  toggleSource(s: 'xhr' | 'atlantis' | 'proxy'): void {
    if (this.sources.has(s)) this.sources.delete(s);
    else this.sources.add(s);
  }

  // Clicking the active sort column flips its direction; a new column starts
  // descending for time (newest first, the default) and ascending otherwise.
  setSort(key: SortKey): void {
    if (this.sort.key === key) {
      this.sort = { key, dir: this.sort.dir === 'asc' ? 'desc' : 'asc' };
    } else {
      this.sort = { key, dir: key === 'time' ? 'desc' : 'asc' };
    }
  }

  // Reset every filter EXCEPT device (the device scope is picked in the topbar,
  // not the filter bar, so "Clear filters" leaves it alone).
  clear(): void {
    this.search = '';
    this.type = 'all';
    this.statuses.clear();
    this.sources.clear();
    this.host = null;
    this.hasBody = false;
    this.sort = { key: 'time', dir: 'desc' };
  }

  #sorted(rows: Row[]): Row[] {
    const { key, dir } = this.sort;
    const f = dir === 'asc' ? 1 : -1;
    const isStr = key === 'method' || key === 'host' || key === 'path';
    // status/size/duration can be null (pending/unknown); time never is.
    const num = (r: Row): number | null =>
      key === 'time' ? r.startedAt : key === 'status' ? r.status : key === 'size' ? r.size : r.durationMs;
    const str = (r: Row): string => (key === 'method' ? r.method : key === 'host' ? r.host : r.path);
    // Copy before sort so the Store's insertion-ordered array is never mutated.
    return [...rows].sort((a, b) => {
      if (isStr) return f * str(a).localeCompare(str(b));
      const av = num(a);
      const bv = num(b);
      // Nulls sink to the bottom regardless of direction — never into the middle.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return f * (av - bv);
    });
  }
}
