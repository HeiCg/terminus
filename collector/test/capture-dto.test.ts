import { describe, it, expect } from 'vitest';
import { Store } from '../src/store.js';
import type { EntryInput } from '../src/types.js';
import { createCollectorHarness } from './fixtures/harness.js';

// A complete Atlantis-style byte input (request+response), overridable per field.
function input(over: Partial<EntryInput> = {}): EntryInput {
  return {
    id: 'r1', deviceId: 'd1', source: 'atlantis', startedAt: 1, method: 'GET', url: 'https://x/y',
    requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: null, responseBodySize: 0, responseBodyOmitted: null,
    durationMs: 1, error: null, ...over,
  };
}

describe('capture DTOs — summaries carry BodyRefs, never bytes (T09)', () => {
  it('storedToEntrySummary omits headers and body text, keeping a BodyRef', () => {
    const s = new Store();
    s.addEntryInput(input({ requestBytes: new Uint8Array(Buffer.from('secret-req')), requestBodySize: 10, requestHeaders: { authorization: 'Bearer top-secret' } }));
    const { items } = s.entrySummaryPage();
    expect(items).toHaveLength(1);
    const sum = items[0];
    // No headers, no body text anywhere in the serialized summary.
    expect(JSON.stringify(sum)).not.toContain('secret-req');
    expect(JSON.stringify(sum)).not.toContain('top-secret');
    expect((sum as unknown as { requestHeaders?: unknown }).requestHeaders).toBeUndefined();
    // …but the ref is present so the UI can fetch/cache the bytes.
    expect(sum.requestBody.state).toBe('captured');
    expect(sum.requestBody.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sum.requestBody.size).toBe(10);
  });

  it('a byte-native response patch preserves a captured binary request body', () => {
    const s = new Store();
    const reqBytes = new Uint8Array([0, 1, 2, 253, 254, 255]); // non-UTF8 binary
    // Request captured as binary bytes (the case the retired text adapter dropped).
    s.addEntryInput(input({ status: null, statusText: '', requestBytes: reqBytes, requestBodySize: 6, requestBodyOmitted: 'binary' }));
    // A response arrives via the correlation patch path.
    s.applyDeviceMessage('d1', { type: 'response', id: 'r1', ts: 2, status: 201, statusText: 'Created', headers: {}, body: 'resp-text', bodySize: 9, durationMs: 5 });

    const req = s.entryBody('d1', 'r1', 'request');
    expect(req?.state).toBe('captured');
    expect(req?.encoding).toBe('binary');
    expect(req?.bytes && Array.from(req.bytes)).toEqual(Array.from(reqBytes)); // bytes survived the merge
    const res = s.entryBody('d1', 'r1', 'response');
    expect(res?.state).toBe('captured');
    expect(res?.bytes && Buffer.from(res.bytes).toString('utf8')).toBe('resp-text');
    // Response metadata merged in without a re-index.
    expect(s.entryDetail('d1', 'r1')?.status).toBe(201);
  });

  it('readBodyBytes distinguishes absent (empty 200) from omitted', () => {
    const s = new Store();
    s.addEntryInput(input({ responseBodyOmitted: 'size', responseBodySize: 5_000_000 })); // omitted, no bytes
    const absent = s.entryBody('d1', 'r1', 'request');   // a GET with no request body
    expect(absent?.state).toBe('absent');
    expect(absent?.bytes && absent.bytes.length).toBe(0);
    const omitted = s.entryBody('d1', 'r1', 'response');
    expect(omitted?.state).toBe('omitted');
    expect(omitted?.omitted).toBe('size');
    expect(omitted?.bytes).toBeNull();
    expect(s.entryBody('d1', 'missing', 'request')).toBeNull(); // unknown entry
  });

  it('pages frames by monotonic sequence and reports drop counts in the summary', () => {
    const s = new Store({ limits: { wsMessagesPerSession: 3 } });
    s.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://x/ws', openedAt: 1, frames: [], closedAt: null, closeCode: null, closeReason: '' });
    for (let i = 0; i < 5; i++) s.appendWsFrame('w1', { ts: i, direction: 'in', data: `f${i}`, size: 2, binary: false }, null, 'd1');
    // Session cap 3 → oldest two evicted, sequences keep climbing (2..4 retained).
    const [ws] = s.wsSummaryPage().items;
    expect(ws.retainedFrames).toBe(3);
    expect(ws.totalFrames).toBe(5);
    expect(ws.droppedFrames).toBe(2);
    const page = s.wsFramesPage('d1', 'w1', null)!;
    expect(page.items.map((f) => f.sequence)).toEqual([2, 3, 4]);
    const after = s.wsFramesPage('d1', 'w1', 3)!;
    expect(after.items.map((f) => f.sequence)).toEqual([4]);
    // One frame's payload by sequence.
    expect(Buffer.from(s.frameBody('d1', 'w1', 4)!.bytes!).toString()).toBe('f4');
    expect(s.frameBody('d1', 'w1', 0)).toBeNull(); // evicted sequence
    expect(s.wsFramesPage('d1', 'nope', null)).toBeNull(); // unknown session
  });
});

describe('authenticated snapshot never materializes bodies; bytes fetched on demand', () => {
  it('summarizes without body text and serves the body via /body', async () => {
    const h = await createCollectorHarness();
    try {
      // Fixture inserted by the test — no debug endpoint.
      h.store.addEntryInput(input({
        id: 'r1', deviceId: 'd1',
        responseBytes: new Uint8Array(Buffer.from('body-fixture-secret-free')), responseBodySize: 24, responseBodyOmitted: null,
      }));

      const snapshot = await h.snapshot();
      expect(JSON.stringify(snapshot)).not.toContain('body-fixture-secret-free');
      expect(snapshot.entries.items.length).toBeLessThanOrEqual(200);

      const body = await h.getEntryBody({ deviceId: 'd1', id: 'r1', side: 'response' });
      expect(body).toBe('body-fixture-secret-free');
    } finally { await h.close(); }
  });

  it('maps missing/omitted bodies to 404/410 over HTTP', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      h.store.addEntryInput(input({ id: 'r1', deviceId: 'd1', responseBodyOmitted: 'binary', responseBodySize: 42 }));
      const miss = await fetch(`${h.url}/api/entries/d1/nope/body?side=response`, { headers: { cookie } });
      expect(miss.status).toBe(404);
      const gone = await fetch(`${h.url}/api/entries/d1/r1/body?side=response`, { headers: { cookie } });
      expect(gone.status).toBe(410);
      expect(gone.headers.get('x-body-omitted')).toBe('binary');
    } finally { await h.close(); }
  });
});
