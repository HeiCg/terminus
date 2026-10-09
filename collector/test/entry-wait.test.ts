import { describe, it, expect } from 'vitest';
import type { EntryInput } from '../src/types.js';
import type { EntrySummary } from '../src/uiProtocol.js';
import { createCollectorHarness, type CollectorHarness } from './fixtures/harness.js';
import { apply, completedInner, connectionInner, startInner, until } from './fixtures/atlantisWire.js';

// P4: the long-poll GET /api/entries/wait. Waits are kept short with small
// `timeoutMs`; a "during the wait" entry is written only once the server holds
// the wait (`activeWaits()`), never after a blind sleep.

const input = (id: string, deviceId = 'd1', over: Partial<EntryInput> = {}): EntryInput => ({
  id, deviceId, source: 'atlantis', startedAt: 1, method: 'GET', url: `https://api.example/${id}`,
  requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
  status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: null, responseBodySize: 0,
  responseBodyOmitted: null, durationMs: 1, error: null, ...over,
});

type WaitBody = {
  matched: boolean; items: EntrySummary[]; nearMisses?: EntrySummary[]; nextSeq: number; lastSeq: number;
  epoch: string; now: number; gap: boolean; devices?: string[];
};
type Env = { h: CollectorHarness; get: (p: string, init?: RequestInit) => Promise<Response>; wait: (qs: string) => Promise<WaitBody> };

async function withHarness(fn: (e: Env) => Promise<void>): Promise<void> {
  const h = await createCollectorHarness();
  try {
    const auth = { authorization: `Bearer ${h.adminToken}` };
    const get = (p: string, init: RequestInit = {}) => fetch(h.url + p, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
    const wait = async (qs: string) => {
      const res = await get(`/api/entries/wait?${qs}`);
      expect(res.status).toBe(200);
      return (await res.json()) as WaitBody;
    };
    await fn({ h, get, wait });
  } finally { await h.close(); }
}

const ids = (items: { id: string }[]) => items.map((e) => e.id);
const held = (h: CollectorHarness, n: number) => until(() => h.activeWaits() === n);

describe('GET /api/entries/wait: matching and races (P4)', () => {
  it('answers at once when a match already exists, with the matched envelope', () => withHarness(async ({ h, wait }) => {
    h.store.addEntryInput(input('a'));
    const t0 = Date.now();
    const b = await wait('afterSeq=0&timeoutMs=5000');
    expect(Object.keys(b).sort()).toEqual(['epoch', 'gap', 'items', 'lastSeq', 'matched', 'nextSeq', 'now']);
    expect(b).toMatchObject({ matched: true, nextSeq: 1, lastSeq: 1, epoch: h.store.seqState().epoch, gap: false });
    expect(ids(b.items)).toEqual(['a']);
    expect(b.now).toBeGreaterThanOrEqual(t0);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(h.activeWaits()).toBe(0);
  }));

  it('chained waits from nextSeq see entries arriving before, during and after a wait, without loss or duplicates', () => withHarness(async ({ h, wait }) => {
    const seen: string[] = [];
    let cursor = 0;
    // Before the wait starts.
    h.store.addEntryInput(input('before'));
    let b = await wait(`afterSeq=${cursor}&timeoutMs=5000`);
    seen.push(...ids(b.items)); cursor = b.nextSeq;
    // During the wait.
    const p = wait(`afterSeq=${cursor}&timeoutMs=5000`);
    await held(h, 1);
    h.store.addEntryInput(input('during'));
    b = await p;
    expect(b.matched).toBe(true);
    seen.push(...ids(b.items)); cursor = b.nextSeq;
    // After a wait timed out: the next wait from the same cursor returns it.
    b = await wait(`afterSeq=${cursor}&timeoutMs=20`);
    expect(b).toMatchObject({ matched: false, items: [], nextSeq: cursor });
    h.store.addEntryInput(input('after'));
    b = await wait(`afterSeq=${b.nextSeq}&timeoutMs=5000`);
    seen.push(...ids(b.items)); cursor = b.nextSeq;
    // A burst is drained `limit` at a time, ascending by seq.
    for (const id of ['x1', 'x2', 'x3']) h.store.addEntryInput(input(id));
    b = await wait(`afterSeq=${cursor}&limit=2&timeoutMs=5000`);
    expect(ids(b.items)).toEqual(['x1', 'x2']);
    expect(b.nextSeq).toBe(b.items[1].seq);
    seen.push(...ids(b.items)); cursor = b.nextSeq;
    b = await wait(`afterSeq=${cursor}&limit=50&timeoutMs=5000`);
    seen.push(...ids(b.items)); cursor = b.nextSeq;
    expect(seen).toEqual(['before', 'during', 'after', 'x1', 'x2', 'x3']);
    expect(cursor).toBe(h.store.seqState().lastSeq);
  }));

  it('limit defaults to 1', () => withHarness(async ({ h, wait }) => {
    h.store.addEntryInput(input('a')); h.store.addEntryInput(input('b'));
    const b = await wait('afterSeq=0');
    expect(ids(b.items)).toEqual(['a']);
    expect(b.nextSeq).toBe(1);
  }));

  it('a non-matching write does not wake the wait; the later match does', () => withHarness(async ({ h, wait }) => {
    const p = wait('afterSeq=0&method=POST&timeoutMs=5000');
    await held(h, 1);
    h.store.addEntryInput(input('get1'));
    expect(h.activeWaits()).toBe(1);
    h.store.addEntryInput(input('post1', 'd1', { method: 'POST' }));
    const b = await p;
    expect(ids(b.items)).toEqual(['post1']);
  }));

  it('an XHR request later patched by its response wakes a completed=true wait', () => withHarness(async ({ h, wait }) => {
    h.store.applyDeviceMessage('d1', { type: 'request', id: 'r1', ts: 1, method: 'POST', url: 'https://api.example/login', headers: {}, body: null, bodySize: 0, source: 'xhr' });
    const p = wait('afterSeq=0&completed=true&timeoutMs=5000');
    await held(h, 1);
    h.store.applyDeviceMessage('d1', { type: 'response', id: 'r1', ts: 2, status: 201, statusText: 'Created', headers: {}, body: null, bodySize: 0, durationMs: 1 });
    const b = await p;
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ id: 'r1', status: 201, seq: 2, firstSeq: 1 });
  }));

  it('an Atlantis start packet then its completion wakes a completed=true wait', () => withHarness(async ({ h, wait }) => {
    apply(h.store, 'K', 'connection', connectionInner({}));
    apply(h.store, 'K', 'traffic', startInner('t1'));
    const { lastSeq } = h.store.seqState();
    const p = wait(`afterSeq=${lastSeq}&completed=true&timeoutMs=5000`);
    await held(h, 1);
    apply(h.store, 'K', 'traffic', completedInner('t1'));
    const b = await p;
    expect(b.items[0]).toMatchObject({ id: 't1', status: 200, firstSeq: lastSeq, seq: lastSeq + 1 });
  }));

  it('newOnly=true ignores the completion of an entry created before the cursor; it is a near miss with its firstSeq', () => withHarness(async ({ h, wait }) => {
    apply(h.store, 'K', 'traffic', startInner('t1'));
    const p = wait('afterSeq=1&newOnly=true&timeoutMs=150');
    await held(h, 1);
    apply(h.store, 'K', 'traffic', completedInner('t1'));
    const b = await p;
    expect(b).toMatchObject({ matched: false, items: [], nextSeq: 1 });
    expect(b.nearMisses!.map((e) => [e.id, e.firstSeq, e.seq])).toEqual([['t1', 1, 2]]);
    // Without newOnly the same cursor sees the completion.
    expect(ids((await wait('afterSeq=1&timeoutMs=0')).items)).toEqual(['t1']);
  }));

  it('a request start that never completes: completed=false returns it, completed=true times out with it as a near miss', () => withHarness(async ({ h, wait }) => {
    apply(h.store, 'K', 'traffic', startInner('hang'));
    const open = await wait('afterSeq=0&completed=false&timeoutMs=0');
    expect(open.matched).toBe(true);
    expect(open.items[0]).toMatchObject({ id: 'hang', status: null, error: null });
    const done = await wait('afterSeq=0&completed=true&timeoutMs=30');
    expect(done.matched).toBe(false);
    expect(ids(done.nearMisses!)).toEqual(['hang']);
  }));

  it('works while the UI is paused', () => withHarness(async ({ h, get, wait }) => {
    const r = await get('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    expect(await r.json()).toEqual({ paused: true });
    const p = wait('afterSeq=0&timeoutMs=5000');
    await held(h, 1);
    h.store.addEntryInput(input('while-paused'));
    expect(ids((await p).items)).toEqual(['while-paused']);
  }));
});

describe('GET /api/entries/wait: timeout shape (P4)', () => {
  it('times out with nearMisses newest first, capped at 5, and the cursor as nextSeq', () => withHarness(async ({ h, wait }) => {
    h.store.addEntryInput(input('old'));                                  // seq 1, below the cursor
    for (let i = 1; i <= 7; i++) h.store.addEntryInput(input(`g${i}`));  // seq 2..8
    h.store.addEntryInput(input('other', 'd2', { method: 'POST' }));      // seq 9, outside the scope
    const t0 = Date.now();
    const b = await wait('afterSeq=1&device=d1&method=POST&timeoutMs=40');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(Object.keys(b).sort()).toEqual(['epoch', 'gap', 'items', 'lastSeq', 'matched', 'nearMisses', 'nextSeq', 'now']);
    expect(b).toMatchObject({ matched: false, items: [], nextSeq: 1, lastSeq: 9, epoch: h.store.seqState().epoch, gap: false });
    expect(ids(b.nearMisses!)).toEqual(['g7', 'g6', 'g5', 'g4', 'g3']);
  }));

  it('timeoutMs=0 is a non-blocking check that holds no slot', () => withHarness(async ({ h, wait }) => {
    const b = await wait('afterSeq=0&timeoutMs=0');
    expect(b).toMatchObject({ matched: false, items: [], nearMisses: [], nextSeq: 0, lastSeq: 0 });
    expect(h.activeWaits()).toBe(0);
  }));

  it('reports gap when entries above the cursor were evicted', () => withHarness(async ({ h, wait }) => {
    h.store.addEntryInput(input('a')); h.store.addEntryInput(input('b'));
    h.store.clear('d1');
    const b = await wait('afterSeq=0&timeoutMs=0');
    expect(b).toMatchObject({ matched: false, gap: true });
  }));

  it('timeoutMs above 30000 is clamped, not refused', () => withHarness(async ({ h, wait }) => {
    h.store.addEntryInput(input('a'));
    expect((await wait('afterSeq=0&timeoutMs=99999999')).matched).toBe(true);
  }));
});

describe('GET /api/entries/wait: errors (P4)', () => {
  it.each([
    'timeoutMs=10', 'afterSeq=', 'afterSeq=-1', 'afterSeq=1.5', 'afterSeq=0&cursor=abc', 'afterSeq=0&last=5',
    'afterSeq=0&limit=0', 'afterSeq=0&limit=51', 'afterSeq=0&limit=x', 'afterSeq=0&timeoutMs=-1', 'afterSeq=0&timeoutMs=1.5',
    'afterSeq=0&newOnly=1', 'afterSeq=0&status=6xx', 'afterSeq=0&method=', 'afterSeq=0&completed=yes', 'afterSeq=0&source=nope',
    `afterSeq=0&urlContains=${'u'.repeat(513)}`,
  ])('400 bad_request: %s', (qs) => withHarness(async ({ h, get }) => {
    const res = await get(`/api/entries/wait?${qs}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_request' });
    expect(h.activeWaits()).toBe(0);
  }));

  it('409 stale_cursor on a wrong epoch or afterSeq past lastSeq; the right epoch is accepted', () => withHarness(async ({ h, get }) => {
    h.store.addEntryInput(input('a'));
    const { epoch } = h.store.seqState();
    for (const qs of ['afterSeq=0&epoch=other', 'afterSeq=2']) {
      const res = await get(`/api/entries/wait?${qs}&timeoutMs=0`);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'stale_cursor', epoch, lastSeq: 1 });
    }
    expect((await get(`/api/entries/wait?afterSeq=1&epoch=${epoch}&timeoutMs=0`)).status).toBe(200);
  }));

  it('only GET is allowed', () => withHarness(async ({ get }) => {
    expect((await get('/api/entries/wait?afterSeq=0', { method: 'POST' })).status).toBe(405);
  }));

  it('does not shadow the parametric routes, including a device named wait', () => withHarness(async ({ h, get }) => {
    h.store.addEntryInput(input('r1', 'wait', { method: 'POST' }));
    const detail = await get('/api/entries/wait/r1');
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ deviceId: 'wait', id: 'r1' });
    expect((await get('/api/entries/wait/r1/body')).status).toBe(200);
    expect((await get('/api/entries/d1/r1')).status).toBe(404);
    const scoped = await (await get('/api/entries/wait?afterSeq=0&device=wait&timeoutMs=0')).json();
    expect(ids(scoped.items)).toEqual(['r1']);
  }));
});

describe('GET /api/entries/wait: auth (P4)', () => {
  it('the reader token can wait; no credential is 401', () => withHarness(async ({ h }) => {
    h.store.addEntryInput(input('a'));
    const ok = await fetch(`${h.url}/api/entries/wait?afterSeq=0&timeoutMs=0`, { headers: { authorization: `Bearer ${h.readerToken}` } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).matched).toBe(true);
    expect((await fetch(`${h.url}/api/entries/wait?afterSeq=0&timeoutMs=0`)).status).toBe(401);
  }));
});

describe('GET /api/entries/wait: device scope re-resolution (P4)', () => {
  it('an externalId wait started before the device connects resolves on that device traffic', () => withHarness(async ({ h, wait }) => {
    const p = wait('afterSeq=0&externalId=emulator-5554&timeoutMs=5000');
    await held(h, 1);
    h.store.addEntryInput(input('noise', 'other'));
    apply(h.store, 'K', 'connection', connectionInner({ device: { name: 'Pixel', model: 'm', externalId: 'emulator-5554' } }));
    expect(h.activeWaits()).toBe(1);
    apply(h.store, 'K', 'traffic', completedInner('t1'));
    const b = await p;
    expect(ids(b.items)).toEqual(['t1']);
    expect(b.devices).toEqual(['K']);
  }));

  it('re-checks the store when a device gains the identity after its traffic is stored', () => withHarness(async ({ h, wait }) => {
    h.store.addEntryInput(input('early', 'K2'));
    const p = wait('afterSeq=0&bundleId=com.acme.app&timeoutMs=5000');
    await held(h, 1);
    apply(h.store, 'K2', 'connection', connectionInner({}));
    const b = await p;
    expect(ids(b.items)).toEqual(['early']);
    expect(b.devices).toEqual(['K2']);
  }));

  it('an identity-scoped timeout echoes the (empty) devices', () => withHarness(async ({ wait }) => {
    const b = await wait('afterSeq=0&externalId=nobody&timeoutMs=0');
    expect(b).toMatchObject({ matched: false, devices: [], nearMisses: [] });
  }));
});

describe('GET /api/entries/wait: capacity, cancellation and lifecycle (P4)', () => {
  it('holds 16 waits, refuses the 17th with 429, frees a slot on abort, and leaves no listeners or waits behind', () => withHarness(async ({ h, get }) => {
    const baseline = { entry: h.store.listenerCount('entry'), device: h.store.listenerCount('device'), clear: h.store.listenerCount('clear') };
    const aborts = Array.from({ length: 16 }, () => new AbortController());
    const pending = aborts.map((a) => get('/api/entries/wait?afterSeq=0&timeoutMs=30000', { signal: a.signal }).catch(() => null));
    await held(h, 16);
    expect(h.store.listenerCount('entry')).toBe(baseline.entry + 1);

    const over = await get('/api/entries/wait?afterSeq=0&timeoutMs=30000');
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: 'too_many_waits', limit: 16 });

    aborts[0].abort();
    await held(h, 15);
    const extra = new AbortController();
    const again = get('/api/entries/wait?afterSeq=0&timeoutMs=30000', { signal: extra.signal }).catch(() => null);
    await held(h, 16);

    for (const a of [...aborts, extra]) a.abort();
    await held(h, 0);
    await Promise.all([...pending, again]);
    expect({ entry: h.store.listenerCount('entry'), device: h.store.listenerCount('device'), clear: h.store.listenerCount('clear') }).toEqual(baseline);
  }));

  it('a match answers every waiter it satisfies through one shared listener', () => withHarness(async ({ h, wait }) => {
    const ps = [wait('afterSeq=0&timeoutMs=5000'), wait('afterSeq=0&method=GET&timeoutMs=5000'), wait('afterSeq=0&method=POST&timeoutMs=150')];
    await held(h, 3);
    expect(h.store.listenerCount('entry')).toBe(1);
    h.store.addEntryInput(input('g'));
    const [a, b, c] = await Promise.all(ps);
    expect([a.matched, b.matched, c.matched]).toEqual([true, true, false]);
    expect(h.store.listenerCount('entry')).toBe(0);
  }));

  it('a clear during a wait ends it with the timeout shape and gap true', () => withHarness(async ({ h, wait }) => {
    h.store.addEntryInput(input('a'));
    const p = wait('afterSeq=1&timeoutMs=5000');
    await held(h, 1);
    h.store.clear();
    const b = await p;
    expect(b).toMatchObject({ matched: false, items: [], nearMisses: [], nextSeq: 1, gap: true });
    expect(h.activeWaits()).toBe(0);
  }));

  it('a clear of another device leaves a device-scoped wait pending', () => withHarness(async ({ h, wait }) => {
    const p = wait('afterSeq=0&device=d1&timeoutMs=5000');
    await held(h, 1);
    h.store.clear('d2');
    expect(h.activeWaits()).toBe(1);
    h.store.addEntryInput(input('a', 'd1'));
    expect((await p).matched).toBe(true);
  }));

  it('shutdown answers a pending wait instead of hanging', async () => {
    const h = await createCollectorHarness();
    const p = fetch(`${h.url}/api/entries/wait?afterSeq=0&timeoutMs=30000`, { headers: { authorization: `Bearer ${h.adminToken}` } });
    await held(h, 1);
    const t0 = Date.now();
    await h.close();
    const res = await p;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matched: false, items: [], nextSeq: 0 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(h.activeWaits()).toBe(0);
    expect(h.store.listenerCount('entry')).toBe(0);
  });
});
