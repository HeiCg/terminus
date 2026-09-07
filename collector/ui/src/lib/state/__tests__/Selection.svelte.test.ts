import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Store } from '../Store.svelte.js';
import { BodyCache } from '../../bodyCache.js';
import { Selection } from '../Selection.svelte.js';
import type { Row } from '../Filters.svelte.js';
import type { BodyRef, EntryDetail, EntrySummary } from '../../protocol.js';

const captured = (sha: string, size: number): BodyRef =>
  ({ state: 'captured', sha256: sha, size, storedSize: size, encoding: 'utf8', omitted: null });
const absent: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };
const omittedRef: BodyRef = { state: 'omitted', sha256: null, size: 99, storedSize: 0, encoding: 'utf8', omitted: 'size' };

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'r1', deviceId: 'd1', source: 'atlantis', startedAt: 1, method: 'GET',
    url: 'https://api.test/thing', status: 200, durationMs: 3, error: null,
    requestBody: absent, responseBody: captured('resp-hash', 20),
    kind: 'xhr', host: 'api.test', path: '/thing', bucket: '2xx', size: 20, ...over,
  };
}

function summary(r: Row): EntrySummary {
  const { kind: _k, host: _h, path: _p, bucket: _b, size: _s, ...rest } = r;
  return rest;
}

const detail: EntryDetail = {
  ...summary(row()), requestHeaders: { 'x-a': 'b' }, responseHeaders: { 'content-type': 'application/json' }, statusText: 'OK',
};

function makeApi() {
  return {
    fetchEntryDetail: vi.fn(async () => detail),
    fetchBody: vi.fn(async () => ({ kind: 'ok', text: '{"ok":true}' }) as const),
  };
}

let store: Store;
let cache: BodyCache;

beforeEach(() => {
  store = new Store();
  cache = new BodyCache();
});

describe('Selection', () => {
  it('loads detail and the response body through the cache, fetching once', async () => {
    const api = makeApi();
    const sel = new Selection({ store, cache, api });
    await sel.select(row());
    expect(api.fetchEntryDetail).toHaveBeenCalledTimes(1);
    expect(sel.detail).toEqual(detail);
    expect(sel.detailStatus).toBe('ok');
    expect(sel.bodies.response.kind).toBe('ok');
    expect(api.fetchBody).toHaveBeenCalledTimes(1);
    expect(cache.has('resp-hash')).toBe(true);

    // Re-selecting the same row reuses the cached body: no second fetch.
    await sel.select(row());
    expect(api.fetchBody).toHaveBeenCalledTimes(1);
  });

  it('never fetches an omitted body and reports the omission reason', async () => {
    const api = makeApi();
    const sel = new Selection({ store, cache, api });
    await sel.select(row({ responseBody: omittedRef }));
    expect(api.fetchBody).not.toHaveBeenCalled();
    expect(sel.bodies.response).toEqual({ kind: 'omitted', reason: 'size', size: 99 });
  });

  it('maps a 410 (omitted) response body to an omitted state', async () => {
    const api = makeApi();
    api.fetchBody.mockResolvedValueOnce({ kind: 'omitted', reason: 'budget' } as never);
    const sel = new Selection({ store, cache, api });
    await sel.select(row());
    expect(sel.bodies.response.kind).toBe('omitted');
    expect(sel.bodies.response).toMatchObject({ reason: 'budget' });
  });

  it('maps a 404 (gone) response body to a gone state', async () => {
    const api = makeApi();
    api.fetchBody.mockResolvedValueOnce({ kind: 'gone' } as never);
    const sel = new Selection({ store, cache, api });
    await sel.select(row());
    expect(sel.bodies.response.kind).toBe('gone');
  });

  it('loads the request body once when the payload tab is opened', async () => {
    const api = makeApi();
    const sel = new Selection({ store, cache, api });
    await sel.select(row({ requestBody: captured('req-hash', 10) }));
    api.fetchBody.mockClear();
    await sel.setTab('payload');
    expect(sel.tab).toBe('payload');
    expect(sel.bodies.request.kind).toBe('ok');
    expect(api.fetchBody).toHaveBeenCalledTimes(1);
    expect(api.fetchBody).toHaveBeenCalledWith('d1', 'r1', 'request');
  });

  it('inlines --data-raw in the cURL once the request body loads', async () => {
    const api = makeApi();
    api.fetchBody.mockResolvedValue({ kind: 'ok', text: '{"hi":1}' } as never);
    const sel = new Selection({ store, cache, api });
    await sel.select(row({ requestBody: captured('req-hash', 8) }));
    await sel.setTab('curl');
    expect(sel.bodies.request.kind).toBe('ok');
    expect(sel.curl).toContain('--data-raw');
    expect(sel.curl).not.toContain('not loaded');
  });

  it('annotates the cURL with the byte size when the request body cannot be loaded', async () => {
    const api = makeApi();
    api.fetchBody.mockResolvedValue({ kind: 'gone' } as never);
    const sel = new Selection({ store, cache, api });
    await sel.select(row({ requestBody: captured('req-hash', 4096) }));
    await sel.setTab('curl');
    expect(sel.bodies.request.kind).not.toBe('ok');
    expect(sel.curl).not.toContain('--data-raw');
    expect(sel.curl).toContain('# request body (4096 bytes) not loaded');
  });

  it('resolves a fast A→B row switch to B body, never leaving B stuck loading', async () => {
    const api = makeApi();
    const A = row({ id: 'A', responseBody: captured('hash-A', 5) });
    const B = row({ id: 'B', responseBody: captured('hash-B', 5) });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const defer = () => {
      let resolve!: (v: { kind: 'ok'; text: string }) => void;
      const p = new Promise<{ kind: 'ok'; text: string }>((r) => (resolve = r));
      return { p, resolve };
    };
    const dA = defer();
    const dB = defer();
    api.fetchBody.mockReturnValueOnce(dA.p as never).mockReturnValueOnce(dB.p as never);

    const sel = new Selection({ store, cache, api });
    const pA = sel.select(A);
    await flush(); // A registers its pending response load (fetch #1)
    const pB = sel.select(B);
    await flush(); // B starts its OWN load (fetch #2), not A's stale promise

    dA.resolve({ kind: 'ok', text: '"A"' }); // stale: must not set the body
    dB.resolve({ kind: 'ok', text: '"B"' });
    await Promise.all([pA, pB]);

    expect(api.fetchBody).toHaveBeenCalledTimes(2); // B did not reuse A's promise
    expect(sel.bodies.response.kind).toBe('ok');
    expect(sel.bodies.response).toMatchObject({ hash: 'hash-B' });
  });

  it('surfaces error (not gone) when the body fetch throws, with no unhandled rejection', async () => {
    const api = makeApi();
    api.fetchBody.mockRejectedValueOnce(new Error('boom'));
    const sel = new Selection({ store, cache, api });
    await sel.select(row());
    expect(sel.bodies.response.kind).toBe('error');
  });

  it('surfaces error for a transport failure and recovers on retry', async () => {
    const api = makeApi();
    api.fetchBody.mockResolvedValueOnce({ kind: 'error' } as never);
    const sel = new Selection({ store, cache, api });
    await sel.select(row());
    expect(sel.bodies.response.kind).toBe('error');

    // Retry: the next fetch succeeds and the body materializes.
    api.fetchBody.mockResolvedValueOnce({ kind: 'ok', text: '{"ok":true}' } as never);
    await sel.loadBody('response');
    expect(sel.bodies.response.kind).toBe('ok');
    expect(api.fetchBody).toHaveBeenCalledTimes(2);
  });

  it('treats a captured ref with no sha256 as gone, never a blank ok', async () => {
    const api = makeApi();
    const noHash: BodyRef = { state: 'captured', sha256: null, size: 5, storedSize: 5, encoding: 'utf8', omitted: null };
    const sel = new Selection({ store, cache, api });
    await sel.select(row({ responseBody: noHash }));
    expect(sel.bodies.response.kind).toBe('gone');
    expect(api.fetchBody).not.toHaveBeenCalled();
  });

  it('sizes an ok body by real bytes when the ref carries no size', async () => {
    const api = makeApi();
    // Response ref with size null: fall back to the body's real UTF-8 byte length.
    const noSize: BodyRef = { state: 'captured', sha256: 'mb', size: null, storedSize: 0, encoding: 'utf8', omitted: null };
    api.fetchBody.mockResolvedValueOnce({ kind: 'ok', text: '€€€' } as never); // 3 chars, 9 bytes
    const sel = new Selection({ store, cache, api });
    await sel.select(row({ responseBody: noSize }));
    expect(sel.bodies.response).toMatchObject({ kind: 'ok', size: 9 });
  });

  it('sizes a binary (base64) body by its decoded byte length', async () => {
    const api = makeApi();
    const noSize: BodyRef = { state: 'captured', sha256: 'bin', size: null, storedSize: 0, encoding: 'binary', omitted: null };
    api.fetchBody.mockResolvedValueOnce({ kind: 'ok', text: 'AAAA' } as never); // 4 base64 chars → 3 bytes
    const sel = new Selection({ store, cache, api });
    await sel.select(row({ responseBody: noSize }));
    expect(sel.bodies.response).toMatchObject({ kind: 'ok', size: 3 });
  });

  it('reset() drops selection, detail and the detail cache', async () => {
    const api = makeApi();
    const sel = new Selection({ store, cache, api });
    await sel.select(row());
    expect(sel.current).not.toBeNull();
    expect(sel.detailsCache.size).toBeGreaterThan(0);
    sel.reset();
    expect(sel.current).toBeNull();
    expect(sel.detail).toBeNull();
    expect(sel.detailStatus).toBe('idle');
    expect(sel.detailsCache.size).toBe(0);
    expect(sel.bodies.response.kind).toBe('idle');
  });

  it('drops the selection when the selected row leaves the store', async () => {
    const api = makeApi();
    const r = row();
    store.apply([{ type: 'entry', entry: summary(r) }]);
    const sel = new Selection({ store, cache, api });
    await sel.select(r);
    expect(sel.current?.id).toBe('r1');
    store.apply([{ type: 'clear', deviceId: null }]);
    expect(sel.current).toBeNull();
    expect(sel.detailStatus).toBe('idle');
  });

  it('stops reacting to the store after dispose', async () => {
    const api = makeApi();
    const r = row();
    store.apply([{ type: 'entry', entry: summary(r) }]);
    const sel = new Selection({ store, cache, api });
    await sel.select(r);
    sel.dispose();
    store.apply([{ type: 'clear', deviceId: null }]);
    expect(sel.current?.id).toBe('r1'); // listener removed: selection is kept
  });
});
