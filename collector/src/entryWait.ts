import type http from 'node:http';
import type { Store, DeviceScopeFilter } from './store.js';
import type { EntrySummary } from './uiProtocol.js';
import { log } from './log.js';
import { deviceScopeFilter, nonNegIntParam, parseEntryFilters, storeMatchEnv, type EntryMatch, type Parsed } from './entryFilters.js';
import type { MatchEnv } from './filterLang.js';

// P4: the long-poll `GET /api/entries/wait` and its shared dispatcher.

export const MAX_WAITS = 16;
const TIMEOUT_DEFAULT_MS = 10_000;
const TIMEOUT_MAX_MS = 30_000;
const LIMIT_DEFAULT = 1;
const LIMIT_MAX = 50;
const NEAR_MISSES = 5;

type WaitQuery = { afterSeq: number; newOnly: boolean; limit: number; timeoutMs: number; match: EntryMatch | undefined };

// Validate the wait parameters. Same strictness and errors as the afterSeq read:
// `cursor`/`last` are refused, `afterSeq` is required, `limit` is 1..50 and
// `timeoutMs` a non-negative integer clamped to 30 s.
function parseWaitQuery(q: URLSearchParams, env: MatchEnv): Parsed<WaitQuery> {
  const bad = (message: string): Parsed<never> => ({ ok: false, message });
  if (q.has('cursor')) return bad('wait cannot be combined with cursor');
  if (q.has('last')) return bad('wait cannot be combined with last');
  if (!q.has('afterSeq')) return bad('afterSeq is required');
  const afterSeq = nonNegIntParam(q, 'afterSeq');
  if (afterSeq === null) return bad('afterSeq must be a non-negative integer');
  let newOnly = false;
  if (q.has('newOnly')) {
    const raw = q.get('newOnly');
    if (raw !== 'true' && raw !== 'false') return bad('newOnly must be true or false');
    newOnly = raw === 'true';
  }
  let limit = LIMIT_DEFAULT;
  if (q.has('limit')) {
    const n = nonNegIntParam(q, 'limit');
    if (n === null || n < 1 || n > LIMIT_MAX) return bad(`limit must be between 1 and ${LIMIT_MAX}`);
    limit = n;
  }
  let timeoutMs = TIMEOUT_DEFAULT_MS;
  if (q.has('timeoutMs')) {
    const n = nonNegIntParam(q, 'timeoutMs');
    if (n === null) return bad('timeoutMs must be a non-negative integer');
    timeoutMs = Math.min(n, TIMEOUT_MAX_MS);
  }
  const filters = parseEntryFilters(q, env);
  if (!filters.ok) return filters;
  return { ok: true, value: { afterSeq, newOnly, limit, timeoutMs, match: filters.value } };
}

type Waiter = WaitQuery & {
  scopeFilter: DeviceScopeFilter;
  scope: string[] | null;       // resolved device ids (null: unscoped)
  members: Set<string> | null;
  echo: boolean;                // externalId/bundleId named: echo `devices`
  timer: NodeJS.Timeout | null;
  res: http.ServerResponse;
};

export type EntryWaits = {
  // Serve one `GET /api/entries/wait` (auth already checked by the caller).
  handle(res: http.ServerResponse, q: URLSearchParams): void;
  // Pending waits (tests and status).
  size(): number;
  // Shutdown: answer every pending wait with the timeout shape and clear timers.
  close(): void;
};

// The long-poll dispatcher. Waiters live in one set; while any exists, ONE
// listener per Store event ('entry', 'device', 'clear') serves them all, and it
// is detached when the last waiter leaves, so an idle collector holds none.
//
// No lost wakeup: the initial store check and the registration run in the same
// synchronous turn of `handle`, and the Store emits 'entry' synchronously after
// every write, so an entry is either already visible to the check or delivered
// to the listener. A patch that turns a non-match into a match (a response
// completing a request) is a write like any other and is re-tested.
export function createEntryWaits(store: Store, opts: { max?: number } = {}): EntryWaits {
  const max = opts.max ?? MAX_WAITS;
  const env = storeMatchEnv(store);
  const waiters = new Set<Waiter>();
  let attached = false;

  const write = (res: http.ServerResponse, status: number, body: unknown, close = false) => {
    const headers: http.OutgoingHttpHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    if (close) headers.connection = 'close';
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };

  const query = (w: Waiter) => store.entriesAfterSeq(w.afterSeq, { deviceIds: w.scope ?? undefined, limit: w.limit, newOnly: w.newOnly, match: w.match });
  const withDevices = (w: Waiter, body: Record<string, unknown>) => (w.echo && w.scope ? { ...body, devices: w.scope } : body);

  // The matched response from the current store state, or null when nothing matches.
  const matched = (w: Waiter): Record<string, unknown> | null => {
    const { items, nextSeq, lastSeq, epoch, now, gap } = query(w);
    return items.length ? withDevices(w, { matched: true, items, nextSeq, lastSeq, epoch, now, gap }) : null;
  };

  // The timeout response: no items, the cursor echoed as `nextSeq`, and the
  // most recent entries above the cursor in the device scope that failed the
  // remaining filters (newOnly included), newest first.
  const timedOut = (w: Waiter, forceGap = false): Record<string, unknown> => {
    const { lastSeq, epoch, now, gap } = query(w);
    const passes = (e: EntrySummary) => (!w.newOnly || (e.firstSeq ?? 0) > w.afterSeq) && (!w.match || w.match(e));
    const misses = store.lastEntries(NEAR_MISSES, { deviceIds: w.scope ?? undefined, floorSeq: w.afterSeq, match: (e) => !passes(e) }).items.reverse();
    return withDevices(w, { matched: false, items: [], nearMisses: misses, nextSeq: w.afterSeq, lastSeq, epoch, now, gap: gap || forceGap });
  };

  const rescope = (w: Waiter) => {
    w.scope = store.resolveDeviceScope(w.scopeFilter);
    w.members = w.scope ? new Set(w.scope) : null;
  };

  // Remove a waiter (answered, timed out, cancelled) and its timer; detach the
  // shared listeners when it was the last one. Idempotent.
  const drop = (w: Waiter) => {
    if (!waiters.delete(w)) return;
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    if (waiters.size === 0) detach();
  };
  const finish = (w: Waiter, body: Record<string, unknown>, close = false) => {
    drop(w);
    try { write(w.res, 200, body, close); } catch (e) { log.warn('entries/wait response failed', String(e)); }
  };

  // Listeners run inside the Store's write path: never let one throw into it.
  const guard = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
    try { fn(...a); } catch (e) { log.warn('entries/wait dispatch failed', String(e)); }
  };
  const onEntry = guard((e: EntrySummary) => {
    for (const w of [...waiters]) {
      if (w.members && !w.members.has(e.deviceId)) continue;
      if (w.newOnly && (e.firstSeq ?? 0) <= w.afterSeq) continue;
      if (w.match && !w.match(e)) continue;
      const body = matched(w);
      if (body) finish(w, body);
    }
  });
  // A device appearing, or gaining the identity an externalId/bundleId (or an
  // alias) wait names, can widen the scope after the wait started: re-resolve,
  // and re-check the store when it changed (its traffic may already be stored).
  const onDevice = guard(() => {
    for (const w of [...waiters]) {
      if (!w.scope) continue;
      const before = w.scope.join('\n');
      rescope(w);
      if (w.scope!.join('\n') === before) continue;
      const body = matched(w);
      if (body) finish(w, body);
    }
  });
  // A clear under a pending wait ends it (timeout shape, `gap` forced true): the
  // records it might have been about to see are gone.
  const onClear = guard((deviceId: string | null) => {
    for (const w of [...waiters]) {
      if (deviceId === null || !w.members || w.members.has(store.resolveDeviceKey(deviceId))) finish(w, timedOut(w, true));
    }
  });

  function attach(): void {
    if (attached) return; attached = true;
    store.on('entry', onEntry); store.on('device', onDevice); store.on('clear', onClear);
  }
  function detach(): void {
    if (!attached) return; attached = false;
    store.off('entry', onEntry); store.off('device', onDevice); store.off('clear', onClear);
  }

  return {
    handle(res, q) {
      const parsed = parseWaitQuery(q, env);
      if (!parsed.ok) {
        const { message, offset } = parsed;
        return write(res, 400, offset === undefined ? { error: 'bad_request', message } : { error: 'bad_request', message, offset });
      }
      const { epoch, lastSeq } = store.seqState();
      if ((q.has('epoch') && q.get('epoch') !== epoch) || parsed.value.afterSeq > lastSeq) {
        return write(res, 409, { error: 'stale_cursor', epoch, lastSeq });
      }
      const scopeFilter = deviceScopeFilter(q);
      const w: Waiter = { ...parsed.value, scopeFilter, scope: null, members: null, echo: !!(scopeFilter.externalId || scopeFilter.bundleId), timer: null, res };
      rescope(w);

      // From here to the registration below nothing yields to the event loop.
      const ready = matched(w);
      if (ready) return write(res, 200, ready);
      if (w.timeoutMs === 0) return write(res, 200, timedOut(w));
      if (waiters.size >= max) return write(res, 429, { error: 'too_many_waits', limit: max });
      waiters.add(w);
      attach();
      w.timer = setTimeout(() => finish(w, timedOut(w)), w.timeoutMs);
      w.timer.unref?.();
      // A client that goes away cancels its wait at once, freeing the slot.
      res.on('close', () => drop(w));
    },
    size: () => waiters.size,
    close() {
      for (const w of [...waiters]) finish(w, timedOut(w), true);
    },
  };
}
