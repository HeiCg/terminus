import { describe, it, expect } from 'vitest';
import type { EntryInput } from '../src/types.js';
import type { EntrySummary } from '../src/uiProtocol.js';
import { CAPABILITIES } from '../src/version.js';
import { createCollectorHarness, type CollectorHarness } from './fixtures/harness.js';
import { until } from './fixtures/atlantisWire.js';

// U2: the `q=<expression>` filter-language parameter on GET /api/entries
// (afterSeq/last) and /api/entries/wait. It ANDs with the P4 filters and the
// device scope; it is a 400 in legacy cursor mode like the other filters.

const input = (id: string, deviceId: string, over: Partial<EntryInput> = {}): EntryInput => ({
  id, deviceId, source: 'atlantis', startedAt: 1, method: 'GET', url: `https://api.example/${id}`,
  requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
  status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: null, responseBodySize: 0,
  responseBodyOmitted: null, durationMs: 1, error: null, ...over,
});

// seq 1..6 in this order.
const seed = (h: CollectorHarness): void => {
  const s = h.store;
  s.touchDevice({ deviceId: 'd1', platform: 'ios', appVersion: '1', buildProfile: 'dev', dropped: 0, lastSeen: 1, externalId: 'emu-1', bundleId: 'com.acme.app' });
  s.recordAlias('d1-alias', 'd1');
  s.addEntryInput(input('get200', 'd1', { responseHeaders: { 'Content-Type': 'application/json; charset=utf-8' }, durationMs: 40 }));          // 1
  s.addEntryInput(input('post201', 'd1', { method: 'POST', status: 201, url: 'https://api.example/v1/login', requestHeaders: { 'X-Trace': 'abc-1' }, durationMs: 900 })); // 2
  s.addEntryInput(input('put404', 'd2', { method: 'PUT', status: 404, responseHeaders: { 'content-type': 'text/html' } }));                     // 3
  s.addEntryInput(input('get500', 'd2', { status: 500, source: 'proxy', durationMs: 3000 }));                                                   // 4
  s.addEntryInput(input('pending', 'd1', { method: 'POST', status: null, durationMs: null }));                                                  // 5
  s.addEntryInput(input('failed', 'd2', { status: null, error: 'timeout', url: 'http://cdn.example:8080/img.png' }));                          // 6
};

async function withHarness(fn: (h: CollectorHarness, get: (p: string) => Promise<Response>) => Promise<void>): Promise<void> {
  const h = await createCollectorHarness();
  try {
    const auth = { authorization: `Bearer ${h.adminToken}` };
    await fn(h, (p) => fetch(h.url + p, { headers: auth }));
  } finally { await h.close(); }
}

const ids = (items: { id: string }[]) => items.map((e) => e.id);
const enc = encodeURIComponent;

const CASES: [string, string[]][] = [
  ['status >= 400', ['put404', 'get500']],
  ['status == 2xx or (error)', ['get200', 'post201', 'failed']],
  ['method in {POST, PUT} && not status == 404', ['post201', 'pending']],
  ['not completed', ['pending']],
  ['duration > 500ms', ['post201', 'get500']],
  ['path matches "/v1/*"', ['post201']],
  ['scheme == http and port == 8080', ['failed']],
  ['source == proxy || error contains time', ['get500', 'failed']],
  // Header fields read the stored headers; mime.res the response content type.
  ['req.header.x-trace == abc-1', ['post201']],
  ['header.content-type', ['get200', 'put404']],
  ['mime.res == application/json', ['get200']],
  ['res.header.x-trace', []],
  // `device` also answers to the alias key, externalId and bundleId.
  ['device == d1-alias', ['get200', 'post201', 'pending']],
  ['device == emu-1', ['get200', 'post201', 'pending']],
  ['device == COM.ACME.APP and method == POST', ['post201', 'pending']],
  ['device == d2', ['put404', 'get500', 'failed']],
  // The 0.2 mini-query forms read the same on the server.
  ['method:post status:2xx', ['post201']],
  ['host:cdn', ['failed']],
  ['login', ['post201']],
];

describe('GET /api/entries?q= (U2)', () => {
  it('advertises the query capability', () => {
    expect(CAPABILITIES).toContain('query');
  });

  it.each(CASES)('afterSeq mode: %s', (q, want) => withHarness(async (h, get) => {
    seed(h);
    const res = await get(`/api/entries?afterSeq=0&q=${enc(q)}`);
    expect(res.status).toBe(200);
    expect(ids((await res.json()).items)).toEqual(want);
  }));

  it.each(CASES)('last mode: %s', (q, want) => withHarness(async (h, get) => {
    seed(h);
    const res = await get(`/api/entries?last=200&q=${enc(q)}`);
    expect(res.status).toBe(200);
    expect(ids((await res.json()).items)).toEqual(want);
  }));

  it('ANDs with the P4 filters, the device scope, newOnly and the cursor', () => withHarness(async (h, get) => {
    seed(h);
    const page = async (qs: string) => ids((await (await get(`/api/entries?${qs}`)).json()).items);
    expect(await page(`afterSeq=0&method=POST&q=${enc('status == 2xx')}`)).toEqual(['post201']);
    expect(await page(`afterSeq=0&device=d2&q=${enc('status >= 400')}`)).toEqual(['put404', 'get500']);
    expect(await page(`afterSeq=0&externalId=emu-1&q=${enc('method == GET')}`)).toEqual(['get200']);
    expect(await page(`afterSeq=3&q=${enc('status >= 400')}`)).toEqual(['get500']);
    expect(await page(`last=1&q=${enc('status >= 400')}`)).toEqual(['get500']);
    expect(await page(`afterSeq=0&urlContains=login&completed=true&q=${enc('method == POST')}`)).toEqual(['post201']);
    h.store.addEntryInput(input('pending', 'd1', { method: 'POST', status: 503 }));  // 7: completes seq 5
    expect(await page(`afterSeq=6&newOnly=true&q=${enc('status >= 500')}`)).toEqual([]);
    expect(await page(`afterSeq=6&q=${enc('status >= 500')}`)).toEqual(['pending']);
  }));
});

describe('GET /api/entries?q= errors (U2)', () => {
  const BAD: [string, number | null][] = [
    ['', null],
    ['   ', null],
    ['status >=', 9],
    ['status = 200', 7],
    ['(status == 200', 14],
    ['nope == 1', 0],
    ['status == abc', 10],
    ['body contains x', 0],
    ['body:x', 0],
    [`url ~ "${'a'.repeat(2048)}"`, 2048],
  ];
  it.each(BAD)('400 bad_request with the offset in afterSeq and last modes: %s', (q, offset) => withHarness(async (_h, get) => {
    for (const mode of ['afterSeq=0', 'last=5']) {
      const res = await get(`/api/entries?${mode}&q=${enc(q)}`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ error: 'bad_request' });
      expect(body.message).toMatch(/^q/);
      if (offset === null) expect(body.offset).toBeUndefined();
      else expect(body.offset).toBe(offset);
    }
  }));

  it('q may be given once', () => withHarness(async (_h, get) => {
    const res = await get('/api/entries?afterSeq=0&q=a&q=b');
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('q may be given once');
  }));

  it('q without afterSeq/last (legacy cursor mode or no mode) is 400, never ignored', () => withHarness(async (h, get) => {
    seed(h);
    for (const p of ['/api/entries?q=status%20%3E%3D%20400', '/api/entries?cursor=abc&q=x', '/api/entries?limit=5&q=x']) {
      const res = await get(p);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_request', message: 'filters require afterSeq or last' });
    }
  }));
});

type WaitBody = { matched: boolean; items: EntrySummary[]; nearMisses?: EntrySummary[]; nextSeq: number };

describe('GET /api/entries/wait?q= (U2)', () => {
  const wait = async (get: (p: string) => Promise<Response>, qs: string): Promise<WaitBody> => {
    const res = await get(`/api/entries/wait?${qs}`);
    expect(res.status).toBe(200);
    return (await res.json()) as WaitBody;
  };

  it('answers at once when a stored entry matches q', () => withHarness(async (h, get) => {
    seed(h);
    const b = await wait(get, `afterSeq=0&limit=5&q=${enc('status >= 400 and device == d2')}`);
    expect(b.matched).toBe(true);
    expect(ids(b.items)).toEqual(['put404', 'get500']);
  }));

  it('holds until a write matches q, including a completion of an older entry', () => withHarness(async (h, get) => {
    seed(h);
    const p = wait(get, `afterSeq=6&q=${enc('method == POST and status == 2xx and req.header.x-step == two')}&timeoutMs=5000`);
    await until(() => h.activeWaits() === 1);
    h.store.addEntryInput(input('n1', 'd1', { method: 'POST', status: 201, requestHeaders: { 'X-Step': 'one' } }));
    expect(h.activeWaits()).toBe(1);
    h.store.addEntryInput(input('n2', 'd1', { method: 'POST', status: 201, requestHeaders: { 'x-step': 'TWO' } }));
    const b = await p;
    expect(b.matched).toBe(true);
    expect(ids(b.items)).toEqual(['n2']);
  }));

  it('nearMisses are the entries in the device scope that fail q or the other filters', () => withHarness(async (h, get) => {
    seed(h);
    const b = await wait(get, `afterSeq=0&device=d1&method=POST&q=${enc('status >= 500')}&timeoutMs=0`);
    expect(b.matched).toBe(false);
    expect(ids(b.nearMisses!)).toEqual(['pending', 'post201', 'get200']);
    const c = await wait(get, `afterSeq=0&device=d2&q=${enc('method == DELETE')}&timeoutMs=20`);
    expect(c.matched).toBe(false);
    expect(ids(c.nearMisses!)).toEqual(['failed', 'get500', 'put404']);
  }));

  it('a bad q is 400 with the offset', () => withHarness(async (_h, get) => {
    const res = await get(`/api/entries/wait?afterSeq=0&q=${enc('status >')}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_request', offset: 8 });
    const empty = await get('/api/entries/wait?afterSeq=0&q=');
    expect(empty.status).toBe(400);
  }));
});
