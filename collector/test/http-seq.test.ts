import { describe, it, expect } from 'vitest';
import type { EntryInput } from '../src/types.js';
import type { Store } from '../src/store.js';
import { createCollectorHarness, type CollectorHarness } from './fixtures/harness.js';

const input = (id: string, deviceId: string, over: Partial<EntryInput> = {}): EntryInput => ({
  id, deviceId, source: 'atlantis', startedAt: 1, method: 'GET', url: `https://x/${id}`,
  requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
  status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: null, responseBodySize: 0,
  responseBodyOmitted: null, durationMs: 1, error: null, ...over,
});

const seedN = (store: Store, n: number, deviceId = 'd1'): void => {
  for (let i = 1; i <= n; i++) store.addEntryInput(input(`e${i}`, deviceId));
};

async function withHarness(fn: (h: CollectorHarness, get: (p: string) => Promise<Response>) => Promise<void>): Promise<void> {
  const h = await createCollectorHarness();
  try {
    const cookie = await h.login();
    await fn(h, (p) => fetch(h.url + p, { headers: { cookie } }));
  } finally { await h.close(); }
}

describe('/health and /api/status advertise the automation API (P1)', () => {
  it('/health carries apiVersion 1 and the seq capability', async () => {
    const h = await createCollectorHarness();
    try {
      const body = await (await fetch(h.url + '/health')).json();
      expect(body).toMatchObject({ status: 'ok', apiVersion: 1 });
      expect(body.capabilities).toEqual(['seq']);
    } finally { await h.close(); }
  });

  it('/api/status carries epoch, lastSeq, now, apiVersion and capabilities', () => withHarness(async (h, get) => {
    seedN(h.store, 2);
    const t0 = Date.now();
    const b = await (await get('/api/status')).json();
    expect(b.epoch).toBe(h.store.seqState().epoch);
    expect(b.lastSeq).toBe(2);
    expect(b.now).toBeGreaterThanOrEqual(t0);
    expect(b.apiVersion).toBe(1);
    expect(b.capabilities).toEqual(['seq']);
  }));
});

describe('GET /api/entries?afterSeq= (P1)', () => {
  it('returns the seq envelope in ascending seq with the new summary fields', () => withHarness(async (h, get) => {
    seedN(h.store, 3);
    const res = await get('/api/entries?afterSeq=1');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(Object.keys(b).sort()).toEqual(['epoch', 'gap', 'hasMore', 'items', 'lastSeq', 'nextSeq', 'now']);
    expect(b.items.map((e: { id: string }) => e.id)).toEqual(['e2', 'e3']);
    expect(b.items[0]).toMatchObject({ seq: 2, firstSeq: 2, receivedAt: expect.any(Number) });
    expect(b).toMatchObject({ nextSeq: 3, lastSeq: 3, epoch: h.store.seqState().epoch, gap: false, hasMore: false });
  }));

  it('honours limit, device and newOnly, and echoes afterSeq as nextSeq when empty', () => withHarness(async (h, get) => {
    seedN(h.store, 4, 'd1'); seedN(h.store, 2, 'd2');
    const lim = await (await get('/api/entries?afterSeq=0&limit=3')).json();
    expect(lim.items).toHaveLength(3);
    expect(lim).toMatchObject({ nextSeq: 3, hasMore: true });
    const dev = await (await get('/api/entries?afterSeq=0&device=d2')).json();
    expect(dev.items.map((e: { deviceId: string; id: string }) => `${e.deviceId}:${e.id}`)).toEqual(['d2:e1', 'd2:e2']);
    const empty = await (await get('/api/entries?afterSeq=6')).json();
    expect(empty).toMatchObject({ items: [], nextSeq: 6, hasMore: false });

    h.store.addEntryInput(input('e1', 'd1', { status: 500 })); // update an entry created before the cursor
    h.store.addEntryInput(input('n1', 'd1'));
    const all = await (await get('/api/entries?afterSeq=6&newOnly=false')).json();
    expect(all.items.map((e: { id: string }) => e.id)).toEqual(['e1', 'n1']);
    const fresh = await (await get('/api/entries?afterSeq=6&newOnly=true')).json();
    expect(fresh.items.map((e: { id: string }) => e.id)).toEqual(['n1']);
  }));

  it('accepts the current epoch and answers 409 stale_cursor on a wrong epoch or afterSeq > lastSeq', () => withHarness(async (h, get) => {
    seedN(h.store, 2);
    const { epoch } = h.store.seqState();
    expect((await get(`/api/entries?afterSeq=0&epoch=${epoch}`)).status).toBe(200);
    for (const p of ['/api/entries?afterSeq=0&epoch=not-this-boot', '/api/entries?afterSeq=3']) {
      const res = await get(p);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'stale_cursor', epoch, lastSeq: 2 });
    }
  }));

  it('reports gap after a clear', () => withHarness(async (h, get) => {
    seedN(h.store, 2);
    h.store.clear();
    expect((await (await get('/api/entries?afterSeq=0')).json()).gap).toBe(true);
    expect((await (await get('/api/entries?afterSeq=2')).json()).gap).toBe(false);
  }));
});

describe('GET /api/entries?last= (P1)', () => {
  it('returns the n most recent by seq in ascending order with hasMore false', () => withHarness(async (h, get) => {
    seedN(h.store, 5);
    h.store.addEntryInput(input('e1', 'd1', { status: 404 })); // e1 is now the most recent
    const b = await (await get('/api/entries?last=3')).json();
    expect(b.items.map((e: { id: string }) => e.id)).toEqual(['e4', 'e5', 'e1']);
    expect(b).toMatchObject({ lastSeq: 6, nextSeq: 6, hasMore: false, gap: false, epoch: h.store.seqState().epoch, now: expect.any(Number) });
    seedN(h.store, 2, 'd2');
    const dev = await (await get('/api/entries?last=200&device=d2')).json();
    expect(dev.items.map((e: { id: string }) => e.id)).toEqual(['e1', 'e2']);
  }));
});

describe('GET /api/entries seq parameters: 400 on bad combinations and values (P1)', () => {
  it.each([
    'afterSeq=0&cursor=abc',
    'last=3&afterSeq=0',
    'last=3&cursor=abc',
    'afterSeq=-1',
    'afterSeq=1.5',
    'afterSeq=abc',
    'afterSeq=',
    'afterSeq=0&limit=0',
    'afterSeq=0&limit=x',
    'afterSeq=0&newOnly=yes',
    'last=0',
    'last=201',
    'last=abc',
    'last=3&newOnly=true',
    'last=3&limit=2',
  ])('%s -> 400', (q) => withHarness(async (h, get) => {
    seedN(h.store, 2);
    const res = await get(`/api/entries?${q}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_request');
  }));
});

describe('GET /api/entries without afterSeq/last keeps the cursor-paginated shape (P1)', () => {
  it('answers {items, nextCursor} only', () => withHarness(async (h, get) => {
    seedN(h.store, 3);
    const b = await (await get('/api/entries?limit=2')).json();
    expect(Object.keys(b).sort()).toEqual(['items', 'nextCursor']);
    expect(b.items.map((e: { id: string }) => e.id)).toEqual(['e1', 'e2']);
    const b2 = await (await get(`/api/entries?cursor=${b.nextCursor}`)).json();
    expect(b2.items.map((e: { id: string }) => e.id)).toEqual(['e3']);
  }));
});
