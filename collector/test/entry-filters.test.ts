import { describe, it, expect } from 'vitest';
import type { EntryInput } from '../src/types.js';
import { createCollectorHarness, type CollectorHarness } from './fixtures/harness.js';

// P4: server-side entry filters (method, urlContains, status, source, completed)
// on GET /api/entries in the afterSeq and last modes. They AND together and with
// the device scope and newOnly; outside those modes they are a 400.

const input = (id: string, deviceId: string, over: Partial<EntryInput> = {}): EntryInput => ({
  id, deviceId, source: 'atlantis', startedAt: 1, method: 'GET', url: `https://api.example/${id}`,
  requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
  status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: null, responseBodySize: 0,
  responseBodyOmitted: null, durationMs: 1, error: null, ...over,
});

// One fixed corpus, seq 1..8 in this order.
const seed = (h: CollectorHarness): void => {
  const s = h.store;
  s.addEntryInput(input('get200', 'd1'));                                                              // 1
  s.addEntryInput(input('post201', 'd1', { method: 'POST', status: 201, url: 'https://API.example/Login' })); // 2
  s.addEntryInput(input('put404', 'd1', { method: 'put', status: 404 }));                               // 3
  s.addEntryInput(input('get500', 'd2', { status: 500, source: 'proxy' }));                             // 4
  s.addEntryInput(input('pending', 'd2', { method: 'POST', status: null, durationMs: null }));          // 5
  s.addEntryInput(input('failed', 'd1', { status: null, error: 'timeout' }));                           // 6
  s.addEntryInput(input('del299', 'd2', { method: 'DELETE', status: 299, source: 'xhr' }));             // 7
  s.addEntryInput(input('get302', 'd1', { status: 302, source: 'replay', url: 'https://cdn.example/x?q=login' })); // 8
};

async function withHarness(fn: (h: CollectorHarness, get: (p: string) => Promise<Response>) => Promise<void>): Promise<void> {
  const h = await createCollectorHarness();
  try {
    const cookie = await h.login();
    await fn(h, (p) => fetch(h.url + p, { headers: { cookie } }));
  } finally { await h.close(); }
}

const ids = (b: { items: { id: string }[] }) => b.items.map((e) => e.id);

const CASES: [string, string[]][] = [
  ['method=POST', ['post201', 'pending']],
  ['method=post', ['post201', 'pending']],
  ['method=GET,POST', ['get200', 'post201', 'get500', 'pending', 'failed', 'get302']],
  ['method=PUT', ['put404']],
  ['method=get,%20delete', ['get200', 'get500', 'failed', 'del299', 'get302']],
  ['urlContains=login', ['post201', 'get302']],
  ['urlContains=API.EXAMPLE', ['get200', 'post201', 'put404', 'get500', 'pending', 'failed', 'del299']],
  ['urlContains=%3Fq%3D', ['get302']],
  ['status=201', ['post201']],
  ['status=2xx', ['get200', 'post201', 'del299']],
  ['status=5XX', ['get500']],
  ['status=200-299', ['get200', 'post201', 'del299']],
  ['status=300-404', ['put404', 'get302']],
  ['status=404-404', ['put404']],
  ['source=proxy', ['get500']],
  ['source=xhr', ['del299']],
  ['source=atlantis', ['get200', 'post201', 'put404', 'pending', 'failed']],
  ['completed=true', ['get200', 'post201', 'put404', 'get500', 'failed', 'del299', 'get302']],
  ['completed=false', ['pending']],
  // Combinations AND together, and with the device scope.
  ['method=GET&status=2xx', ['get200']],
  ['method=GET&completed=true&source=atlantis', ['get200', 'failed']],
  ['device=d2&method=POST,DELETE', ['pending', 'del299']],
  ['device=d1&status=200-399&urlContains=example', ['get200', 'post201', 'get302']],
  ['status=2xx&completed=false', []],
];

describe('GET /api/entries filters (P4)', () => {
  it.each(CASES)('afterSeq mode: %s', (qs, want) => withHarness(async (h, get) => {
    seed(h);
    const res = await get(`/api/entries?afterSeq=0&${qs}`);
    expect(res.status).toBe(200);
    expect(ids(await res.json())).toEqual(want);
  }));

  it.each(CASES)('last mode: %s', (qs, want) => withHarness(async (h, get) => {
    seed(h);
    const res = await get(`/api/entries?last=200&${qs}`);
    expect(res.status).toBe(200);
    expect(ids(await res.json())).toEqual(want);
  }));

  it('last=n keeps the n most recent matches, ascending', () => withHarness(async (h, get) => {
    seed(h);
    expect(ids(await (await get('/api/entries?last=2&completed=true')).json())).toEqual(['del299', 'get302']);
  }));

  it('afterSeq honours the cursor, limit and nextSeq over the filtered set', () => withHarness(async (h, get) => {
    seed(h);
    const p1 = await (await get('/api/entries?afterSeq=0&method=GET&limit=2')).json();
    expect(ids(p1)).toEqual(['get200', 'get500']);
    expect(p1).toMatchObject({ nextSeq: 4, hasMore: true });
    const p2 = await (await get(`/api/entries?afterSeq=${p1.nextSeq}&method=GET&limit=2`)).json();
    expect(ids(p2)).toEqual(['failed', 'get302']);
    expect(p2).toMatchObject({ nextSeq: 8, hasMore: false });
  }));

  it('filters combine with newOnly: an update of an older entry is excluded, a new match is kept', () => withHarness(async (h, get) => {
    seed(h);
    h.store.addEntryInput(input('pending', 'd2', { method: 'POST', status: 201 })); // 9: completes seq-5 entry
    h.store.addEntryInput(input('fresh', 'd2', { method: 'POST', status: 202 }));   // 10
    expect(ids(await (await get('/api/entries?afterSeq=8&status=2xx')).json())).toEqual(['pending', 'fresh']);
    expect(ids(await (await get('/api/entries?afterSeq=8&status=2xx&newOnly=true')).json())).toEqual(['fresh']);
  }));
});

describe('GET /api/entries filter errors (P4)', () => {
  const BAD: string[] = [
    'method=', 'method=GET,', 'method=G%20T', 'method=GET&method=POST',
    'urlContains=', `urlContains=${'a'.repeat(513)}`,
    'status=', 'status=20', 'status=2000', 'status=abc', 'status=6xx', 'status=0xx', 'status=2x',
    'status=299-200', 'status=200-', 'status=-299', 'status=200-2999', 'status=099',
    'source=', 'source=ATLANTIS', 'source=nope',
    'completed=', 'completed=yes', 'completed=1', 'completed=TRUE',
  ];
  it.each(BAD)('400 bad_request in afterSeq and last modes: %s', (qs) => withHarness(async (_h, get) => {
    for (const mode of ['afterSeq=0', 'last=5']) {
      const res = await get(`/api/entries?${mode}&${qs}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_request' });
    }
  }));

  it('urlContains of exactly 512 characters is accepted', () => withHarness(async (_h, get) => {
    expect((await get(`/api/entries?afterSeq=0&urlContains=${'a'.repeat(512)}`)).status).toBe(200);
  }));

  it.each(['method=GET', 'urlContains=x', 'status=200', 'source=proxy', 'completed=true'])(
    'filter %s without afterSeq/last (legacy cursor mode or no mode) is 400, never ignored', (qs) => withHarness(async (h, get) => {
      seed(h);
      for (const p of [`/api/entries?${qs}`, `/api/entries?cursor=abc&${qs}`, `/api/entries?limit=5&${qs}`]) {
        const res = await get(p);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'bad_request' });
      }
    }));
});
