import { describe, it, expect, vi, afterEach } from 'vitest';
import { SeqIndex } from '../src/retention.js';
import { Store } from '../src/store.js';
import { decodeAtlantis } from '../src/atlantis/decode.js';
import { applyAtlantisEvent } from '../src/atlantis/server.js';
import type { EntryInput } from '../src/types.js';

const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

const input = (id: string, deviceId: string, over: Partial<EntryInput> = {}): EntryInput => ({
  id, deviceId, source: 'atlantis', startedAt: 1, method: 'GET', url: `https://x/${id}`,
  requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
  status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: null, responseBodySize: 0,
  responseBodyOmitted: null, durationMs: 1, error: null, ...over,
});

const ids = (s: Store, afterSeq: number, opts: Parameters<Store['entriesAfterSeq']>[1] = {}): string[] =>
  s.entriesAfterSeq(afterSeq, opts).items.map((e) => `${e.deviceId}:${e.id}`);

// An XHR request message, then (optionally) its response, as the JS ingest sends them.
const xhrRequest = (s: Store, deviceId: string, id: string, ts = 1): void => void s.applyDeviceMessage(deviceId,
  { type: 'request', id, ts, method: 'GET', url: `https://x/${id}`, headers: {}, body: null, bodySize: 0, source: 'xhr' });
const xhrResponse = (s: Store, deviceId: string, id: string, ts = 2): void => void s.applyDeviceMessage(deviceId,
  { type: 'response', id, ts, status: 200, statusText: 'OK', headers: {}, body: 'ok', bodySize: 2, durationMs: 1 });

afterEach(() => { vi.restoreAllMocks(); });

describe('SeqIndex (P1)', () => {
  it('walks strictly after a sequence in ascending order and skips removed slots', () => {
    const ix = new SeqIndex();
    for (let i = 1; i <= 6; i++) ix.insert(i, `k${i}`);
    ix.remove(3); ix.remove(5);
    expect([...ix.after(0)].map((n) => n.key)).toEqual(['k1', 'k2', 'k4', 'k6']);
    expect([...ix.after(3)].map((n) => n.seq)).toEqual([4, 6]);
    expect([...ix.after(6)]).toEqual([]);
    expect([...ix.descending()].map((n) => n.seq)).toEqual([6, 4, 2, 1]);
    expect(ix.size()).toBe(4);
  });

  it('stays correct across compaction of many removed slots', () => {
    const ix = new SeqIndex();
    for (let i = 1; i <= 1000; i++) ix.insert(i, `k${i}`);
    for (let i = 1; i <= 990; i++) ix.remove(i);
    expect(ix.size()).toBe(10);
    expect([...ix.after(0)].map((n) => n.seq)).toEqual([991, 992, 993, 994, 995, 996, 997, 998, 999, 1000]);
    expect([...ix.after(995)].map((n) => n.seq)).toEqual([996, 997, 998, 999, 1000]);
    ix.insert(1001, 'k1001');
    expect([...ix.descending()][0]).toEqual({ seq: 1001, key: 'k1001' });
  });

  it('refuses a sequence that does not grow', () => {
    const ix = new SeqIndex();
    ix.insert(5, 'a');
    expect(() => ix.insert(5, 'b')).toThrow();
  });
});

describe('Store sequence (P1)', () => {
  it('starts at lastSeq 0 and gives every Store its own random epoch', () => {
    const a = new Store(); const b = new Store();
    expect(a.seqState().lastSeq).toBe(0);
    expect(a.seqState().epoch).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 bytes, base64url
    expect(a.seqState().epoch).not.toBe(b.seqState().epoch);
  });

  it('returns exact arrival order for two devices whose clocks are far ahead and far behind', () => {
    const s = new Store();
    const ahead = Date.now() + 10 * 365 * 24 * 3600_000;
    const behind = 1_000;
    s.addEntryInput(input('a1', 'dA', { startedAt: ahead }));
    s.addEntryInput(input('b1', 'dB', { startedAt: behind }));
    s.addEntryInput(input('a2', 'dA', { startedAt: ahead + 1 }));
    s.addEntryInput(input('b2', 'dB', { startedAt: behind + 1 }));
    s.addEntryInput(input('a3', 'dA', { startedAt: ahead - 5 }));
    expect(ids(s, 0)).toEqual(['dA:a1', 'dB:b1', 'dA:a2', 'dB:b2', 'dA:a3']);
    expect(s.entriesAfterSeq(0).items.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(ids(s, 2)).toEqual(['dA:a2', 'dB:b2', 'dA:a3']);
    expect(ids(s, 0, { deviceId: 'dB' })).toEqual(['dB:b1', 'dB:b2']);
  });

  it('still returns an entry whose upsert moved startedAt before the cursor', () => {
    const s = new Store();
    s.addEntryInput(input('e1', 'd1', { startedAt: 5_000 }));
    s.addEntryInput(input('e2', 'd1', { startedAt: 6_000 }));
    const cursor = s.seqState().lastSeq;
    s.addEntryInput(input('e1', 'd1', { startedAt: 10 })); // re-sent with an earlier start
    const page = s.entriesAfterSeq(cursor);
    expect(page.items.map((e) => e.id)).toEqual(['e1']);
    expect(page.items[0]).toMatchObject({ seq: 3, firstSeq: 1, startedAt: 10 });
  });

  it('re-surfaces an XHR response patch with a higher seq and the same firstSeq/receivedAt', () => {
    const s = new Store();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    xhrRequest(s, 'd1', 'r1');
    xhrRequest(s, 'd1', 'r2');
    const before = s.entriesAfterSeq(0).items.find((e) => e.id === 'r1')!;
    expect(before).toMatchObject({ seq: 1, firstSeq: 1, receivedAt: 1_000, status: null });
    now.mockReturnValue(9_000);
    xhrResponse(s, 'd1', 'r1');
    const page = s.entriesAfterSeq(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: 'r1', seq: 3, firstSeq: 1, receivedAt: 1_000, status: 200 });
    // The entry appears once, at its current seq, never at the superseded one.
    expect(s.entriesAfterSeq(0).items.map((e) => `${e.id}@${e.seq}`)).toEqual(['r2@2', 'r1@3']);
    expect(s.entryDetail('d1', 'r1')).toMatchObject({ seq: 3, firstSeq: 1, receivedAt: 1_000 });
  });

  it('re-surfaces an upsert (same id twice via addEntryInput) with a higher seq and the same firstSeq/receivedAt', () => {
    const s = new Store();
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000);
    s.addEntryInput(input('p1', 'd1', { status: null, durationMs: null }));
    now.mockReturnValue(7_000);
    s.addEntryInput(input('p1', 'd1'));
    const page = s.entriesAfterSeq(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: 'p1', seq: 2, firstSeq: 1, receivedAt: 2_000, status: 200 });
    expect(s.entriesAfterSeq(0).items).toHaveLength(1);
  });

  it('carries seq, firstSeq and receivedAt on the live entry delta', () => {
    const s = new Store();
    const seen: unknown[] = [];
    s.on('entry', (e) => seen.push(e));
    xhrRequest(s, 'd1', 'r1');
    xhrResponse(s, 'd1', 'r1');
    expect(seen).toMatchObject([{ seq: 1, firstSeq: 1 }, { seq: 2, firstSeq: 1 }]);
  });

  it('newOnly hides an entry created before the cursor and updated after it', () => {
    const s = new Store();
    xhrRequest(s, 'd1', 'old');
    const cursor = s.seqState().lastSeq;
    xhrResponse(s, 'd1', 'old');
    xhrRequest(s, 'd1', 'new');
    expect(s.entriesAfterSeq(cursor, { newOnly: true }).items.map((e) => e.id)).toEqual(['new']);
    expect(s.entriesAfterSeq(cursor, { newOnly: false }).items.map((e) => e.id)).toEqual(['old', 'new']);
  });

  it('applies a caller predicate (the hook later filters build on)', () => {
    const s = new Store();
    s.addEntryInput(input('g', 'd1', { method: 'GET' }));
    s.addEntryInput(input('p', 'd1', { method: 'POST' }));
    expect(s.entriesAfterSeq(0, { match: (e) => e.method === 'POST' }).items.map((e) => e.id)).toEqual(['p']);
  });

  it('reports nextSeq as the last returned seq, or the received afterSeq when empty', () => {
    const s = new Store();
    for (let i = 0; i < 3; i++) s.addEntryInput(input(`e${i}`, 'd1'));
    expect(s.entriesAfterSeq(0).nextSeq).toBe(3);
    expect(s.entriesAfterSeq(3).nextSeq).toBe(3);
    expect(s.entriesAfterSeq(0, { deviceId: 'nobody' })).toMatchObject({ items: [], nextSeq: 0, lastSeq: 3, hasMore: false });
  });

  it('pages through more than one page via nextSeq, yielding every entry exactly once', () => {
    const s = new Store({ limits: { httpPerDevice: 1000 } });
    for (let i = 0; i < 450; i++) s.addEntryInput(input(`e${i}`, i % 2 ? 'd1' : 'd2'));
    const seen: string[] = [];
    const hasMore: boolean[] = [];
    let after = 0;
    for (;;) {
      const p = s.entriesAfterSeq(after);
      seen.push(...p.items.map((e) => e.id));
      hasMore.push(p.hasMore);
      after = p.nextSeq;
      if (!p.hasMore) break;
    }
    expect(hasMore).toEqual([true, true, false]); // 200 + 200 + 50
    expect(seen).toHaveLength(450);
    expect(new Set(seen).size).toBe(450);
    expect(seen).toEqual(Array.from({ length: 450 }, (_, i) => `e${i}`));

    // A smaller `limit` walks the same set in more pages.
    const small: string[] = [];
    after = 0;
    for (let guard = 0; guard < 100; guard++) {
      const p = s.entriesAfterSeq(after, { limit: 7, deviceId: 'd1' });
      small.push(...p.items.map((e) => e.id));
      after = p.nextSeq;
      if (!p.hasMore) break;
    }
    expect(small).toEqual(Array.from({ length: 225 }, (_, i) => `e${2 * i + 1}`));
  });

  it('caps a page at 1 MiB serialized', () => {
    const s = new Store({ limits: { maxRecordBytes: 1024 * 1024 } });
    const big = 'u'.repeat(60 * 1024);
    for (let i = 0; i < 40; i++) s.addEntryInput(input(`e${i}`, 'd1', { url: `https://x/${big}${i}` }));
    const p = s.entriesAfterSeq(0);
    expect(p.items.length).toBeGreaterThan(0);
    expect(p.items.length).toBeLessThan(40);
    expect(Buffer.byteLength(JSON.stringify(p.items))).toBeLessThanOrEqual(1024 * 1024);
    expect(p.hasMore).toBe(true);
  });

  it('last=n returns the n most recent by seq, ascending, honouring the device filter', () => {
    const s = new Store();
    for (let i = 1; i <= 5; i++) s.addEntryInput(input(`e${i}`, i <= 3 ? 'd1' : 'd2'));
    s.addEntryInput(input('e2', 'd1')); // modified: now the most recent
    const p = s.lastEntries(3);
    expect(p.items.map((e) => e.id)).toEqual(['e4', 'e5', 'e2']);
    expect(p.items.map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(p).toMatchObject({ nextSeq: 6, lastSeq: 6, hasMore: false, gap: false });
    expect(s.lastEntries(3, { deviceId: 'd1' }).items.map((e) => e.id)).toEqual(['e1', 'e3', 'e2']);
    expect(s.lastEntries(50).items).toHaveLength(5);
  });
});

describe('Store sequence gap (P1)', () => {
  it('is true after eviction by count, false for a cursor past the evicted seq', () => {
    const s = new Store({ limits: { httpPerDevice: 2 } });
    for (let i = 1; i <= 3; i++) s.addEntryInput(input(`e${i}`, 'd1'));
    expect(s.entriesAfterSeq(0).gap).toBe(true);
    expect(s.entriesAfterSeq(1).gap).toBe(false);
  });

  it('is true after body-budget eviction', () => {
    const s = new Store({ limits: { bodyBytes: 20, bodyEvictionFloor: 1, perBodyBytes: 100 } });
    s.addEntryInput(input('e1', 'd1', { responseBytes: bytes('aaaaaaaa'), responseBodySize: 8 }));
    s.addEntryInput(input('e2', 'd1', { responseBytes: bytes('bbbbbbbb'), responseBodySize: 8 }));
    expect(s.entriesAfterSeq(0).gap).toBe(false);
    s.addEntryInput(input('e3', 'd1', { responseBytes: bytes('cccccccc'), responseBodySize: 8 }));
    expect(s.retentionCounters().evictedForBodyBudget).toBe(1);
    expect(s.entriesAfterSeq(0).gap).toBe(true);
    expect(s.entriesAfterSeq(1).gap).toBe(false);
  });

  it('is true after a full clear and after a device clear', () => {
    const s = new Store();
    s.addEntryInput(input('e1', 'd1')); s.addEntryInput(input('e2', 'd2'));
    s.clear();
    expect(s.entriesAfterSeq(1).gap).toBe(true);
    expect(s.entriesAfterSeq(2).gap).toBe(false);
    expect(s.entriesAfterSeq(0, { deviceId: 'd1' }).gap).toBe(true);
    expect(s.entriesAfterSeq(1, { deviceId: 'd1' }).gap).toBe(false);

    const t = new Store();
    t.addEntryInput(input('e1', 'd1')); t.addEntryInput(input('e2', 'd2'));
    t.clear('d2');
    expect(t.entriesAfterSeq(0, { deviceId: 'd2' }).gap).toBe(true);
    expect(t.entriesAfterSeq(0, { deviceId: 'd1' }).gap).toBe(false);
    expect(t.entriesAfterSeq(1).gap).toBe(true);
    // The sequence keeps counting across a clear (same epoch, no reuse).
    t.addEntryInput(input('e3', 'd2'));
    expect(t.entriesAfterSeq(2).items.map((e) => e.seq)).toEqual([3]);
  });

  it('is false when entries were only patched (a superseded seq is not an eviction)', () => {
    const s = new Store();
    xhrRequest(s, 'd1', 'r1'); xhrResponse(s, 'd1', 'r1');
    s.addEntryInput(input('u1', 'd1', { status: null })); s.addEntryInput(input('u1', 'd1'));
    expect(s.entriesAfterSeq(0).gap).toBe(false);
    expect(s.entriesAfterSeq(0, { deviceId: 'd1' }).gap).toBe(false);
  });

  it('per-device gap is not triggered by another device being evicted', () => {
    const s = new Store({ limits: { httpPerDevice: 2 } });
    s.addEntryInput(input('b1', 'd2'));
    for (let i = 1; i <= 3; i++) s.addEntryInput(input(`a${i}`, 'd1')); // evicts a1
    expect(s.entriesAfterSeq(0, { deviceId: 'd1' }).gap).toBe(true);
    expect(s.entriesAfterSeq(0, { deviceId: 'd2' }).gap).toBe(false);
    expect(s.entriesAfterSeq(0).gap).toBe(true);
  });
});

// The Atlantis SDK may send the same envelope id twice: a request-only packet (no
// response, no endAt) and later the completed packet. That is an upsert: one
// entry, whose firstSeq is the first packet's.
describe('Atlantis duplicate id (P1)', () => {
  const packet = (inner: Record<string, unknown>): Buffer => Buffer.from(JSON.stringify({
    id: 'dev-atl', messageType: 'traffic', buildVersion: '1.0', content: Buffer.from(JSON.stringify(inner)).toString('base64'),
  }));
  const request = { url: 'https://x/a', method: 'POST', headers: [], body: Buffer.from('q').toString('base64') };

  it('keeps one entry with the first packet\'s firstSeq and receivedAt', () => {
    const s = new Store();
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000);
    const start = decodeAtlantis(packet({ id: 'T1', startAt: 100, endAt: null, packageType: 'http', request, response: null, responseBodyData: null, error: null }));
    expect(start?.kind).toBe('traffic'); // a request-only packet decodes, it is not rejected
    applyAtlantisEvent(s, start!, 'g1');
    s.addEntryInput(input('other', 'dev-atl'));
    now.mockReturnValue(4_000);
    const done = decodeAtlantis(packet({ id: 'T1', startAt: 100, endAt: 100.25, packageType: 'http', request,
      response: { statusCode: 201, headers: [] }, responseBodyData: Buffer.from('r').toString('base64'), error: null }));
    applyAtlantisEvent(s, done!, 'g1');

    const all = s.entriesAfterSeq(0).items;
    expect(all.filter((e) => e.id === 'T1')).toHaveLength(1);
    expect(all.find((e) => e.id === 'T1')).toMatchObject({ seq: 3, firstSeq: 1, receivedAt: 3_000, status: 201, durationMs: 250 });
    expect(s.entriesAfterSeq(2, { newOnly: true }).items).toEqual([]);
    expect(s.entriesAfterSeq(2).items.map((e) => e.id)).toEqual(['T1']);
  });
});
