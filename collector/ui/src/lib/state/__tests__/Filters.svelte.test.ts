import { describe, it, expect, vi, afterEach } from 'vitest';
import { Store } from '../Store.svelte.js';
import { Filters } from '../Filters.svelte.js';
import { BodyCache } from '../../bodyCache.js';
import * as format from '../../format.js';
import type { SnapshotMessage, EntrySummary, WsSummary, BodyRef } from '../../protocol.js';
import { entityKey } from '../../protocol.js';

afterEach(() => { vi.restoreAllMocks(); });

const absent: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };
const captured = (size: number): BodyRef => ({ state: 'captured', sha256: 'h', size, storedSize: size, encoding: 'utf8', omitted: null });

function entry(over: Partial<EntrySummary> = {}): EntrySummary {
  return {
    id: 'r', deviceId: 'd1', source: 'atlantis', startedAt: 0, method: 'GET',
    url: 'https://api.test/thing', status: 200, durationMs: 10, error: null,
    requestBody: absent, responseBody: absent, ...over,
  };
}

function wsSession(over: Partial<WsSummary>): WsSummary {
  return {
    wsId: 'w', deviceId: 'd1', source: 'xhr', url: 'wss://api.test/ws', openedAt: 0,
    kind: 'websocket', httpEntryKey: null, retainedFrames: 0, totalFrames: 0,
    droppedFrames: 0, partial: false, closedAt: null, closeCode: null, closeReason: '',
    ...over,
  } as WsSummary;
}

// 12 entries: mix of devices, methods, sources, statuses, sizes, and two whose
// keys are linked by WS/SSE sessions below.
function fixture(): SnapshotMessage {
  const entries: EntrySummary[] = [
    entry({ id: 'e1', deviceId: 'd1', method: 'GET', url: 'https://a.test/users', status: 200, startedAt: 1, source: 'atlantis', responseBody: captured(120) }),
    entry({ id: 'e2', deviceId: 'd1', method: 'POST', url: 'https://a.test/login', status: 201, startedAt: 2, source: 'xhr', requestBody: captured(40) }),
    entry({ id: 'e3', deviceId: 'd1', method: 'GET', url: 'https://b.test/feed', status: 304, startedAt: 3, source: 'proxy' }),
    entry({ id: 'e4', deviceId: 'd1', method: 'DELETE', url: 'https://a.test/orders/9', status: 404, startedAt: 4, source: 'atlantis' }),
    entry({ id: 'e5', deviceId: 'd1', method: 'GET', url: 'https://c.test/img', status: 500, startedAt: 5, source: 'proxy', responseBody: captured(9000) }),
    entry({ id: 'e6', deviceId: 'd1', method: 'PUT', url: 'https://a.test/prefs', status: 200, startedAt: 6, source: 'xhr' }),
    entry({ id: 'e7', deviceId: 'd2', method: 'GET', url: 'https://a.test/users', status: 200, startedAt: 7, source: 'atlantis' }),
    entry({ id: 'e8', deviceId: 'd2', method: 'GET', url: 'https://d.test/ping', status: null, error: 'network', startedAt: 8, source: 'xhr' }),
    entry({ id: 'e9', deviceId: 'd2', method: 'GET', url: 'https://b.test/feed', status: 200, startedAt: 9, source: 'proxy', responseBody: captured(500) }),
    entry({ id: 'e10', deviceId: 'd2', method: 'POST', url: 'https://a.test/track', status: 204, startedAt: 10, source: 'atlantis' }),
    // e11 is the HTTP row a WebSocket session upgraded from; e12 carries an SSE stream.
    entry({ id: 'e11', deviceId: 'd1', method: 'GET', url: 'https://a.test/socket', status: 101, startedAt: 11, source: 'atlantis' }),
    entry({ id: 'e12', deviceId: 'd2', method: 'GET', url: 'https://a.test/events', status: 200, startedAt: 12, source: 'atlantis' }),
  ];
  const ws: WsSummary[] = [
    wsSession({ wsId: 'w1', deviceId: 'd1', kind: 'websocket', httpEntryKey: { deviceId: 'd1', id: 'e11' } }),
    wsSession({ wsId: 's1', deviceId: 'd2', kind: 'sse', httpEntryKey: { deviceId: 'd2', id: 'e12' } }),
  ];
  return {
    type: 'snapshot', devices: [], entries: { items: entries, nextCursor: null },
    ws: { items: ws, nextCursor: null }, retention: null, atMax: false, truncated: false, paused: false,
  };
}

function seeded(): { store: Store; filters: Filters } {
  const store = new Store();
  store.apply([fixture()]);
  return { store, filters: new Filters(store) };
}

describe('Filters', () => {
  it('joins WS/SSE kind onto the linked HTTP rows, XHR otherwise', () => {
    const { filters } = seeded();
    const byId = new Map(filters.rows.map((r) => [r.id, r.kind]));
    expect(byId.get('e11')).toBe('ws');
    expect(byId.get('e12')).toBe('sse');
    expect(byId.get('e1')).toBe('xhr');
  });

  it('counts ignore every non-device filter', () => {
    const { filters } = seeded();
    filters.type = 'errors';
    filters.statuses.add('2xx');
    filters.search = 'nonsense';
    expect(filters.counts).toEqual({ all: 12, xhr: 10, ws: 1, sse: 1, errors: 3 });
  });

  it('counts respect the device scope', () => {
    const { filters } = seeded();
    filters.device = 'd2';
    expect(filters.counts).toEqual({ all: 5, xhr: 4, ws: 0, sse: 1, errors: 1 });
  });

  it('hosts are distinct, sorted, and scoped to the device', () => {
    const { filters } = seeded();
    expect(filters.hosts).toEqual(['a.test', 'b.test', 'c.test', 'd.test']);
    filters.device = 'd2';
    expect(filters.hosts).toEqual(['a.test', 'b.test', 'd.test']);
  });

  it('type=xhr excludes the WS/SSE-linked rows', () => {
    const { filters } = seeded();
    filters.type = 'xhr';
    const ids = filters.rows.map((r) => r.id);
    expect(ids).not.toContain('e11');
    expect(ids).not.toContain('e12');
    expect(filters.rows).toHaveLength(10);
  });

  it('type=errors keeps 4xx/5xx/transport-error rows', () => {
    const { filters } = seeded();
    filters.type = 'errors';
    expect(filters.rows.map((r) => r.id).sort()).toEqual(['e4', 'e5', 'e8']);
  });

  it('status chips filter by bucket (union)', () => {
    const { filters } = seeded();
    filters.statuses.add('4xx');
    filters.statuses.add('5xx');
    expect(filters.rows.map((r) => r.id).sort()).toEqual(['e4', 'e5']);
  });

  it('source chips filter by source', () => {
    const { filters } = seeded();
    filters.sources.add('proxy');
    expect(filters.rows.map((r) => r.id).sort()).toEqual(['e3', 'e5', 'e9']);
  });

  it('host select narrows to one host', () => {
    const { filters } = seeded();
    filters.host = 'b.test';
    expect(filters.rows.map((r) => r.id).sort()).toEqual(['e3', 'e9']);
  });

  it('hasBody keeps rows with a captured request or response body', () => {
    const { filters } = seeded();
    filters.hasBody = true;
    expect(filters.rows.map((r) => r.id).sort()).toEqual(['e1', 'e2', 'e5', 'e9']);
  });

  it('search matches url and method, case-insensitively', () => {
    const { filters } = seeded();
    filters.search = 'LOGIN';
    expect(filters.rows.map((r) => r.id)).toEqual(['e2']);
    filters.search = 'delete';
    expect(filters.rows.map((r) => r.id)).toEqual(['e4']);
  });

  it('combines device + type + search', () => {
    const { filters } = seeded();
    filters.device = 'd1';
    filters.type = 'xhr';
    filters.search = 'a.test';
    expect(filters.rows.map((r) => r.id).sort()).toEqual(['e1', 'e2', 'e4', 'e6']);
  });

  it('default sort is time desc (newest first)', () => {
    const { filters } = seeded();
    expect(filters.rows.map((r) => r.id)[0]).toBe('e12');
    expect(filters.rows.at(-1)?.id).toBe('e1');
  });

  it('setSort flips direction on the same key and defaults new keys', () => {
    const { filters } = seeded();
    filters.setSort('time'); // same key → flip to asc
    expect(filters.sort).toEqual({ key: 'time', dir: 'asc' });
    expect(filters.rows.map((r) => r.id)[0]).toBe('e1');
    filters.setSort('size'); // new key → asc
    expect(filters.sort).toEqual({ key: 'size', dir: 'asc' });
    filters.setSort('size'); // flip → desc: largest first (e5 = 9000)
    expect(filters.sort.dir).toBe('desc');
    expect(filters.rows[0].id).toBe('e5');
  });

  it('sorts null-duration rows last in both directions', () => {
    const store = new Store();
    store.apply([{
      type: 'snapshot', devices: [],
      entries: {
        items: [
          entry({ id: 'a', durationMs: 50 }),
          entry({ id: 'b', durationMs: null }),
          entry({ id: 'c', durationMs: 10 }),
          entry({ id: 'd', durationMs: null }),
        ],
        nextCursor: null,
      },
      ws: { items: [], nextCursor: null }, retention: null, atMax: false, truncated: false, paused: false,
    }]);
    const filters = new Filters(store);
    filters.setSort('duration'); // asc
    expect(filters.rows.map((r) => r.id).slice(0, 2)).toEqual(['c', 'a']);
    expect(filters.rows.map((r) => r.id).slice(2).sort()).toEqual(['b', 'd']); // nulls last
    filters.setSort('duration'); // flip → desc
    expect(filters.rows.map((r) => r.id).slice(0, 2)).toEqual(['a', 'c']);
    expect(filters.rows.map((r) => r.id).slice(2).sort()).toEqual(['b', 'd']); // still last
  });

  it('sorts by host ascending', () => {
    const { filters } = seeded();
    filters.setSort('host');
    expect(filters.rows[0].host).toBe('a.test');
  });

  // C6: `new URL()` (via splitUrl) is memoized per entityKey, so a fresh store
  // batch does not re-parse every url — only the newly-arrived rows.
  it('parses each url once across recomputes and only parses new rows', () => {
    const spy = vi.spyOn(format, 'splitUrl');
    const store = new Store();
    store.apply([
      { type: 'entry', entry: entry({ id: 'e1', deviceId: 'd1', url: 'https://a.test/one' }) },
      { type: 'entry', entry: entry({ id: 'e2', deviceId: 'd1', url: 'https://a.test/two' }) },
    ]);
    const filters = new Filters(store);

    expect(filters.allRows.map((r) => r.path).sort()).toEqual(['/one', '/two']);
    const afterFirst = spy.mock.calls.length;
    expect(afterFirst).toBe(2); // one parse per distinct entity

    // A new batch that adds one row: only the new url is parsed, the two existing
    // rows hit the memo.
    store.apply([{ type: 'entry', entry: entry({ id: 'e3', deviceId: 'd1', url: 'https://a.test/three' }) }]);
    expect(filters.allRows.length).toBe(3);
    expect(spy.mock.calls.length).toBe(afterFirst + 1);
  });

  it('evicts a memoized url when its row leaves the store', () => {
    const spy = vi.spyOn(format, 'splitUrl');
    const store = new Store();
    store.apply([{ type: 'entry', entry: entry({ id: 'e1', deviceId: 'd1', url: 'https://a.test/one' }) }]);
    const filters = new Filters(store);
    expect(filters.allRows.length).toBe(1);
    expect(spy.mock.calls.length).toBe(1);

    // Global clear drops the row; a later row with the SAME key must re-parse
    // (the memo entry was evicted alongside the entry).
    store.apply([{ type: 'clear', deviceId: null }]);
    expect(filters.allRows.length).toBe(0);
    store.apply([{ type: 'entry', entry: entry({ id: 'e1', deviceId: 'd1', url: 'https://a.test/one' }) }]);
    expect(filters.allRows.length).toBe(1);
    expect(spy.mock.calls.length).toBe(2);
  });

  it('otherDeviceNew counts arrivals under other devices while a device is selected', () => {
    const store = new Store();
    const filters = new Filters(store);
    // 'all' selected: nothing is "on another device".
    store.apply([{ type: 'entry', entry: entry({ id: 'a', deviceId: 'd1' }) }]);
    expect(filters.otherDeviceNew).toBe(0);

    // Select d1. Arrivals under d1 do not count; arrivals under d2 do.
    filters.device = 'd1';
    store.apply([{ type: 'entry', entry: entry({ id: 'b', deviceId: 'd1' }) }]);
    expect(filters.otherDeviceNew).toBe(0);
    store.apply([
      { type: 'entry', entry: entry({ id: 'c', deviceId: 'd2' }) },
      { type: 'entry', entry: entry({ id: 'd', deviceId: 'd3' }) },
    ]);
    expect(filters.otherDeviceNew).toBe(2);
  });

  it('otherDeviceNew resets when the selected device changes', () => {
    const store = new Store();
    const filters = new Filters(store);
    filters.device = 'd1';
    store.apply([{ type: 'entry', entry: entry({ id: 'c', deviceId: 'd2' }) }]);
    expect(filters.otherDeviceNew).toBe(2 - 1); // 1

    // Switching device (including back to 'all' on "Show all") rebaselines to 0.
    filters.device = 'all';
    expect(filters.otherDeviceNew).toBe(0);
    filters.device = 'd2';
    expect(filters.otherDeviceNew).toBe(0);
    // Now arrivals under d1 are "other".
    store.apply([{ type: 'entry', entry: entry({ id: 'e', deviceId: 'd1' }) }]);
    expect(filters.otherDeviceNew).toBe(1);
  });

  it('otherDeviceNew rebaselines to zero after a snapshot resync', () => {
    const store = new Store();
    const filters = new Filters(store);
    filters.device = 'd1';
    store.apply([{ type: 'entry', entry: entry({ id: 'c', deviceId: 'd2' }) }]);
    expect(filters.otherDeviceNew).toBe(1);
    // A reconnect snapshot zeroes the store counters; the pill must not show a
    // stale backlog. New other-device arrivals after the resync count from zero.
    store.apply([{ type: 'snapshot', devices: [], entries: { items: [], nextCursor: null }, ws: { items: [], nextCursor: null }, retention: null, atMax: false, truncated: false, paused: false }]);
    expect(filters.otherDeviceNew).toBe(0);
    store.apply([{ type: 'entry', entry: entry({ id: 'f', deviceId: 'd2' }) }]);
    expect(filters.otherDeviceNew).toBe(1);
  });

  it('clear resets everything but device', () => {
    const { filters } = seeded();
    filters.device = 'd2';
    filters.type = 'errors';
    filters.statuses.add('4xx');
    filters.sources.add('proxy');
    filters.host = 'a.test';
    filters.hasBody = true;
    filters.search = 'x';
    filters.setSort('size');
    filters.clear();
    expect(filters.device).toBe('d2');
    expect(filters.type).toBe('all');
    expect(filters.statuses.size).toBe(0);
    expect(filters.sources.size).toBe(0);
    expect(filters.host).toBeNull();
    expect(filters.hasBody).toBe(false);
    expect(filters.search).toBe('');
    expect(filters.sort).toEqual({ key: 'time', dir: 'desc' });
  });
});

describe('Filters — mini-query (T6.2)', () => {
  it('method: filters by an OR list, case-insensitively', () => {
    const { filters } = seeded();
    filters.search = 'method:post,delete';
    expect(filters.rows.map((r) => r.id).sort()).toEqual(['e10', 'e2', 'e4']);
  });

  it('status: accepts a class and a range', () => {
    const { filters } = seeded();
    filters.search = 'status:5xx';
    expect(filters.rows.map((r) => r.id)).toEqual(['e5']);
    filters.search = 'status:400-499';
    expect(filters.rows.map((r) => r.id)).toEqual(['e4']);
  });

  it('host: and path: are substrings; source: is exact', () => {
    const { filters } = seeded();
    filters.search = 'host:b.test';
    expect(filters.rows.map((r) => r.id).sort()).toEqual(['e3', 'e9']);
    filters.search = 'source:proxy';
    expect(filters.rows.map((r) => r.id).sort()).toEqual(['e3', 'e5', 'e9']);
  });

  it('composes typed terms with a free substring (AND)', () => {
    const { filters } = seeded();
    filters.search = 'method:get host:a.test users';
    // GET + host a.test + url contains "users": e1 (d1) and e7 (d2)
    expect(filters.rows.map((r) => r.id).sort()).toEqual(['e1', 'e7']);
  });

  it('composes the query with the chip filters (AND)', () => {
    const { filters } = seeded();
    filters.device = 'd1';
    filters.search = 'method:get';
    // Every GET on d1: e1, e3, e5, e11.
    expect(filters.rows.map((r) => r.id).sort()).toEqual(['e1', 'e11', 'e3', 'e5']);
    filters.type = 'xhr'; // now the WS-linked e11 drops out
    expect(filters.rows.map((r) => r.id).sort()).toEqual(['e1', 'e3', 'e5']);
  });

  it('body: matches resident body text when a cache is wired', () => {
    const store = new Store();
    store.apply([fixture()]);
    const cache = new BodyCache();
    cache.putRaw('h', 'the-secret-token');
    const filters = new Filters(store, cache);
    filters.search = 'body:secret';
    // Every row whose request/response body is captured under sha "h".
    expect(filters.rows.map((r) => r.id).sort()).toEqual(['e1', 'e2', 'e5', 'e9']);
  });
});

describe('Filters — URL hash (T6.3)', () => {
  it('a pristine filter set serializes to nothing', () => {
    const { filters } = seeded();
    expect(filters.toHash()).toBe('');
  });

  it('round-trips every serialized field', () => {
    const { store, filters } = seeded();
    filters.device = 'd2';
    filters.type = 'errors';
    filters.toggleStatus('4xx');
    filters.toggleStatus('5xx');
    filters.toggleSource('proxy');
    filters.host = 'a.test';
    filters.search = 'method:get token';
    filters.setSort('size');

    const restored = new Filters(store);
    restored.applyHash(new URLSearchParams(filters.toHash()));

    expect(restored.device).toBe('d2');
    expect(restored.type).toBe('errors');
    expect([...restored.statuses].sort()).toEqual(['4xx', '5xx']);
    expect([...restored.sources]).toEqual(['proxy']);
    expect(restored.host).toBe('a.test');
    expect(restored.search).toBe('method:get token');
    expect(restored.sort).toEqual({ key: 'size', dir: 'asc' });
  });

  it('applyHash ignores unknown/foreign keys and falls back to defaults', () => {
    const { filters } = seeded();
    filters.applyHash(new URLSearchParams('view=sockets&type=bogus&status=9xx&sort=nope'));
    expect(filters.type).toBe('all');
    expect(filters.statuses.size).toBe(0);
    expect(filters.sort).toEqual({ key: 'time', dir: 'desc' });
  });

  it('a setter writes the filter state into location.hash', () => {
    const { filters } = seeded();
    filters.search = 'host:api';
    expect(new URLSearchParams(location.hash.slice(1)).get('q')).toBe('host:api');
    filters.clear();
    expect(new URLSearchParams(location.hash.slice(1)).get('q')).toBeNull();
  });
});
