import { describe, it, expect } from 'vitest';
import { SortedKeyIndex, type SortKey } from '../src/retention.js';
import { Store } from '../src/store.js';
import type { Entry } from '../src/types.js';

const sk = (t: number, d: string, id: string): SortKey => [t, d, id];
const makeEntry = (id: string, deviceId: string, startedAt: number): Entry => ({
  id, deviceId, source: 'xhr', startedAt, method: 'GET', url: `https://x/${id}`,
  requestHeaders: {}, requestBody: null, requestBodySize: 0, requestBodyOmitted: null,
  status: 200, statusText: 'OK', responseHeaders: {}, responseBody: null, responseBodySize: 0,
  responseBodyOmitted: null, durationMs: 1, error: null,
});

describe('SortedKeyIndex (O03)', () => {
  it('keeps a total order across tied and out-of-order timestamps', () => {
    const ix = new SortedKeyIndex();
    ix.insert(sk(200, 'd1', 'b'), { deviceId: 'd1', id: 'b' });
    ix.insert(sk(100, 'd2', 'a'), { deviceId: 'd2', id: 'a' });
    ix.insert(sk(200, 'd1', 'a'), { deviceId: 'd1', id: 'a' }); // tie on ts, tiebreak by id
    ix.insert(sk(100, 'd1', 'a'), { deviceId: 'd1', id: 'a' }); // tie on ts, tiebreak by device
    const { keys } = ix.page(null, 10);
    expect(keys.map((k) => `${k.deviceId}:${k.id}`)).toEqual(['d1:a', 'd2:a', 'd1:a', 'd1:b']);
  });

  it('pages by cursor with a binary search and walk, not sort().slice()', () => {
    const ix = new SortedKeyIndex();
    for (let i = 0; i < 10; i++) ix.insert(sk(i, 'd', `e${i}`), { deviceId: 'd', id: `e${i}` });
    const p1 = ix.page(null, 4);
    expect(p1.keys.map((k) => k.id)).toEqual(['e0', 'e1', 'e2', 'e3']);
    const p2 = ix.page(p1.nextCursor, 4);
    expect(p2.keys.map((k) => k.id)).toEqual(['e4', 'e5', 'e6', 'e7']);
    const p3 = ix.page(p2.nextCursor, 4);
    expect(p3.keys.map((k) => k.id)).toEqual(['e8', 'e9']);
    expect(p3.nextCursor).toBeNull();
  });

  it('resumes correctly when the cursor key was removed mid-pagination', () => {
    const ix = new SortedKeyIndex();
    for (let i = 0; i < 6; i++) ix.insert(sk(i, 'd', `e${i}`), { deviceId: 'd', id: `e${i}` });
    const p1 = ix.page(null, 3); // e0,e1,e2 -> cursor at e2
    ix.remove(sk(2, 'd', 'e2')); // the cursor key itself is evicted
    const p2 = ix.page(p1.nextCursor, 3); // still strictly-after e2
    expect(p2.keys.map((k) => k.id)).toEqual(['e3', 'e4', 'e5']);
  });

  it('sees inserts that land after the cursor during pagination', () => {
    const ix = new SortedKeyIndex();
    ix.insert(sk(10, 'd', 'a'), { deviceId: 'd', id: 'a' });
    ix.insert(sk(30, 'd', 'c'), { deviceId: 'd', id: 'c' });
    const p1 = ix.page(null, 1); // 'a', cursor at (10,d,a)
    ix.insert(sk(20, 'd', 'b'), { deviceId: 'd', id: 'b' }); // arrives after the cursor
    const p2 = ix.page(p1.nextCursor, 10);
    expect(p2.keys.map((k) => k.id)).toEqual(['b', 'c']);
  });
});

describe('Store pagination (O03)', () => {
  it('pages entries by cursor globally and per device', () => {
    const s = new Store();
    for (let i = 0; i < 5; i++) s.addEntry(makeEntry(`a${i}`, 'd1', i));
    for (let i = 0; i < 5; i++) s.addEntry(makeEntry(`b${i}`, 'd2', i + 100));
    const g1 = s.pageEntries(null, 3);
    expect(g1.entries.map((e) => e.id)).toEqual(['a0', 'a1', 'a2']);
    const g2 = s.pageEntries(g1.nextCursor, 3);
    expect(g2.entries.map((e) => e.id)).toEqual(['a3', 'a4', 'b0']);

    const d = s.pageEntries(null, 10, 'd2');
    expect(d.entries.map((e) => e.id)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
    expect(d.nextCursor).toBeNull();
  });

  it('entrySummaryPage returns summaries (BodyRefs, no bodies) capped at 200 records', () => {
    const s = new Store();
    for (let i = 0; i < 250; i++) s.addEntry({ ...makeEntry(`e${String(i).padStart(3, '0')}`, 'd1', i), requestBody: 'body', requestBodySize: 4 });
    const p = s.entrySummaryPage();
    expect(p.items).toHaveLength(200);                    // record cap
    expect(p.nextCursor).not.toBeNull();                 // more available
    expect(p.items[0].requestBody.state).toBe('captured'); // ref only, no body text
    expect(p.items[0].requestBody.size).toBe(4);         // metadata preserved
    expect(JSON.stringify(p.items[0])).not.toContain('"body"'); // body text never inlined
    // Second page resumes exactly after the first, no gaps or repeats.
    const p2 = s.entrySummaryPage(p.nextCursor);
    expect(p2.items).toHaveLength(50);
    expect(p2.items[0].id).toBe('e200');
  });

  it('snapshotEntrySummaries never materializes bodies (O07)', () => {
    const s = new Store();
    s.addEntryInput({
      id: 'e1', deviceId: 'd1', source: 'atlantis', startedAt: 1, method: 'GET', url: 'https://x',
      requestHeaders: {}, requestBytes: new Uint8Array(Buffer.from('secret-body')), requestBodySize: 11, requestBodyOmitted: null,
      status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: null, responseBodySize: 0, responseBodyOmitted: null,
      durationMs: 1, error: null,
    });
    const [sum] = s.snapshotEntrySummaries();
    expect(JSON.stringify(sum)).not.toContain('secret-body'); // not materialized
    expect(sum.requestBody.state).toBe('captured');
    expect(sum.requestBody.size).toBe(11);
  });

  it('keeps paging correct after retention saturates and evicts', () => {
    const s = new Store({ limits: { httpPerDevice: 3, httpGlobal: 3 } });
    for (let i = 0; i < 10; i++) s.addEntry(makeEntry(`e${i}`, 'd1', i));
    // Only the 3 newest survive; the index reflects that.
    const { entries } = s.pageEntries(null, 100, 'd1');
    expect(entries.map((e) => e.id)).toEqual(['e7', 'e8', 'e9']);
  });
});
