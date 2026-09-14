import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store, EXPORT_LEASE_MS } from '../src/store.js';
import { writeHar, writeJson } from '../src/har.js';
import type { EntryInput } from '../src/types.js';
import { scenarios, renderHar } from './fixtures/har/scenarios.js';

// A collecting Writable with a tiny highWaterMark so a multi-chunk stream forces
// real `drain` backpressure through writeChunk (never an unbounded write queue).
// `_write` defers its callback to the next tick, so `write()` returns false once
// the buffer passes the HWM and the writer must await drain.
class MemWritable extends Writable {
  chunks: Buffer[] = [];
  constructor() { super({ highWaterMark: 32 }); }
  _write(chunk: Buffer, _enc: string, cb: (e?: Error) => void): void {
    this.chunks.push(Buffer.from(chunk));
    setImmediate(cb);
  }
  text(): string { return Buffer.concat(this.chunks).toString('utf8'); }
}

const isUtf8 = (b: Uint8Array): boolean => { try { new TextDecoder('utf8', { fatal: true }).decode(b); return true; } catch { return false; } };

type Over = Partial<EntryInput> & { responseBinary?: boolean; requestBinary?: boolean };

function inputEntry(over: Over = {}): EntryInput {
  const { responseBinary, requestBinary, ...rest } = over;
  const base: EntryInput = {
    id: 'r1', deviceId: 'd1', source: 'atlantis', startedAt: 1_700_000_000_000,
    method: 'POST', url: 'https://api.example.io/v1/x?q=1',
    requestHeaders: { 'content-type': 'application/json' }, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/json' },
    responseBytes: null, responseBodySize: 0, responseBodyOmitted: null, durationMs: 42, error: null,
  };
  const e = { ...base, ...rest };
  // Bytes that are not valid UTF-8 (or an explicit flag) mark a captured BINARY body.
  if (e.responseBytes && (responseBinary || !isUtf8(e.responseBytes))) e.responseBodyOmitted = 'binary';
  if (e.requestBytes && (requestBinary || !isUtf8(e.requestBytes))) e.requestBodyOmitted = 'binary';
  return e;
}

async function harOf(store: Store, selection = { deviceId: 'd1' }): Promise<any> {
  const snap = store.acquireExportSnapshot(selection);
  const out = new MemWritable();
  await writeHar(snap, out);
  return JSON.parse(out.text());
}

async function exportFixture(over: Over): Promise<any> {
  const store = new Store();
  store.addEntryInput(inputEntry(over));
  return harOf(store);
}

describe('HAR export — bytes and omissions (E1a/E1c/R5)', () => {
  it('preserves captured binary response bytes as base64 with the true size', async () => {
    const bytes = Buffer.from([0, 255, 195, 40]);
    const har = await exportFixture({ responseBytes: bytes, responseBodySize: bytes.length });
    const content = har.log.entries[0].response.content;
    expect(content.encoding).toBe('base64');
    expect(Buffer.from(content.text, 'base64')).toEqual(bytes);
    expect(content.size).toBe(4);
  });

  it('keeps non-ASCII text as UTF-8 (no base64, no _terminus)', async () => {
    const text = 'héllo — 世界 🌍';
    const bytes = Buffer.from(text, 'utf8');
    const har = await exportFixture({ responseBytes: bytes, responseBodySize: bytes.length });
    const content = har.log.entries[0].response.content;
    expect(content.text).toBe(text);
    expect(content.encoding).toBeUndefined();
    expect(content._terminus).toBeUndefined();
    expect(content.size).toBe(bytes.length);
  });

  it('an empty captured body stays present (text:"" ), an absent one has no text', async () => {
    const empty = await exportFixture({ responseBytes: Buffer.alloc(0), responseBodySize: 0 });
    expect(empty.log.entries[0].response.content.text).toBe('');
    // Absent request/response: no postData at all, response content size 0, no text, no omission.
    const absent = await exportFixture({});
    expect(absent.log.entries[0].request.postData).toBeUndefined();
    const c = absent.log.entries[0].response.content;
    expect(c.text).toBeUndefined();
    expect(c._terminus).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('binary request body uses _terminusContent, never a fabricated postData.text', async () => {
    const bytes = Buffer.from([1, 2, 3, 250, 251]);
    const har = await exportFixture({ requestBytes: bytes, requestBodySize: bytes.length });
    const pd = har.log.entries[0].request.postData;
    // Empty text (schema-required by har-schema 2.0.0), NOT a fabricated UTF-8 body.
    expect(pd.text).toBe('');
    expect(pd._terminusContent.encoding).toBe('base64');
    expect(Buffer.from(pd._terminusContent.text, 'base64')).toEqual(bytes);
    expect(pd._terminusContent.size).toBe(5);
  });

  it('records each omission reason without fabricating a Content-Length', async () => {
    for (const reason of ['size', 'budget', 'not-captured'] as const) {
      const har = await exportFixture({ responseBytes: null, responseBodyOmitted: reason, responseBodySize: 123 });
      const c = har.log.entries[0].response.content;
      expect(c.text).toBeUndefined();
      expect(c._terminus).toEqual({ state: 'omitted', reason, size: 123 });
    }
    // Unknown original size stays absent, not zero-faked.
    const har = await exportFixture({ responseBytes: null, responseBodyOmitted: 'size', responseBodySize: 0 });
    // responseBodySize 0 → size known as 0; a genuinely-unknown size (null on the
    // ref) would drop the field. Here size is 0, so it is reported as 0.
    expect(har.log.entries[0].response.content._terminus.reason).toBe('size');
  });
});

describe('HAR export — WebSocket / SSE union (E1b)', () => {
  function seedWs(store: Store, over: { wsId?: string; kind?: 'websocket'; httpEntryKey?: any } = {}): void {
    store.addWsSession({ wsId: over.wsId ?? 'w1', deviceId: 'd1', source: 'atlantis', url: 'wss://api.example.io/live', openedAt: 1_700_000_000_000,
      closedAt: null, closeCode: null, closeReason: '', kind: over.kind ?? 'websocket', httpEntryKey: over.httpEntryKey ?? null });
  }

  it('emits a synthetic, marked entry with unknown status for a socket without a linked HTTP handshake', async () => {
    const store = new Store();
    seedWs(store);
    store.appendWsFrame('w1', { ts: 1_700_000_001_000, direction: 'out', data: 'ping', size: 4, binary: false }, null, 'd1');
    store.appendWsFrame('w1', { ts: 1_700_000_002_000, direction: 'in', data: 'pong', size: 4, binary: false }, null, 'd1');
    const har = await harOf(store);
    expect(har.log.entries).toHaveLength(1);
    const e = har.log.entries[0];
    expect(e.response.status).toBe(0);
    expect(e._terminus.synthetic).toBe(true);
    expect(e._terminus.statusUnknown).toBe(true);
    expect(e.timings).toEqual({ send: -1, wait: -1, receive: -1 });
    // send/receive in SECONDS; opcode 1 for complete text; no url-based matching.
    expect(e._webSocketMessages).toEqual([
      { type: 'send', time: 1_700_000_001, opcode: 1, data: 'ping' },
      { type: 'receive', time: 1_700_000_002, opcode: 1, data: 'pong' },
    ]);
  });

  it('attaches messages to the linked HTTP entry and does NOT duplicate the handshake', async () => {
    const store = new Store();
    store.addEntryInput(inputEntry({ id: 'h1', method: 'GET', url: 'https://api.example.io/live', status: 101, statusText: 'Switching Protocols' }));
    seedWs(store, { wsId: 'w1', httpEntryKey: { deviceId: 'd1', id: 'h1' } });
    store.appendWsFrame('w1', { ts: 1_700_000_003_000, direction: 'in', data: 'hi', size: 2, binary: false }, null, 'd1');
    const har = await harOf(store);
    // Union is one entry (the HTTP handshake) carrying the frames, not two.
    expect(har.log.entries).toHaveLength(1);
    const e = har.log.entries[0];
    expect(e.request.url).toBe('https://api.example.io/live');
    expect(e._webSocketMessages).toHaveLength(1);
    // The HTTP entry carries its identity; the linked socket rides `_terminus.sessions`.
    expect(e._terminus).toMatchObject({ deviceId: 'd1', id: 'h1', source: 'atlantis' });
    expect(Array.isArray(e._terminus.sessions)).toBe(true);
    expect(e._terminus.sessions).toHaveLength(1);
  });

  it('carries binary frames as base64 with opcode 2 and marks the encoding', async () => {
    const store = new Store();
    seedWs(store);
    const bytes = Buffer.from([9, 254, 0, 3]);
    store.appendWsFrame('w1', { ts: 1_700_000_004_000, direction: 'in', data: null, size: bytes.length, binary: true }, bytes, 'd1');
    const e = (await harOf(store)).log.entries[0];
    const m = e._webSocketMessages[0];
    expect(m.opcode).toBe(2);
    expect(Buffer.from(m.data, 'base64')).toEqual(bytes);
    expect(m._terminus).toEqual({ encoding: 'base64' });
  });

  it('gives SSE its own extension, not _webSocketMessages', async () => {
    const store = new Store();
    store.addWsSession({ wsId: 's1', deviceId: 'd1', source: 'atlantis', url: 'https://api.example.io/sse', openedAt: 1_700_000_000_000,
      closedAt: null, closeCode: null, closeReason: '', kind: 'sse', httpEntryKey: null });
    store.appendWsFrame('s1', { ts: 1_700_000_005_000, direction: 'in', data: 'event: tick', size: 11, binary: false }, null, 'd1');
    const e = (await harOf(store)).log.entries[0];
    expect(e._webSocketMessages).toBeUndefined();
    expect(e._terminusEventStream).toHaveLength(1);
    expect(e._terminusEventStream[0].opcode).toBeUndefined(); // no WS opcode inferred for SSE
    expect(e._terminus.kind).toBe('sse');
  });

  it('records the close frame and dropped/partial frame counts in _terminus', async () => {
    const store = new Store({ limits: { wsMessagesPerSession: 1 } });
    seedWs(store);
    store.appendWsFrame('w1', { ts: 1_700_000_006_000, direction: 'in', data: 'a', size: 1, binary: false }, null, 'd1');
    store.appendWsFrame('w1', { ts: 1_700_000_006_500, direction: 'in', data: 'b', size: 1, binary: false }, null, 'd1'); // evicts 'a'
    store.closeWs('w1', 1_700_000_007_000, 1000, 'bye', 'd1');
    const e = (await harOf(store)).log.entries[0];
    expect(e._terminus.close).toEqual({ at: 1_700_000_007_000, code: 1000, reason: 'bye' });
    expect(e._terminus.droppedFrames).toBe(1);
    expect(e._terminus.totalFrames).toBe(2);
    expect(e._terminus.retainedFrames).toBe(1);
  });
});

describe('HAR export — selection, isolation and schema (R5)', () => {
  it('keeps two devices that reuse the same entry id separate', async () => {
    const store = new Store();
    store.addEntryInput(inputEntry({ deviceId: 'dA', id: 'same' }));
    store.addEntryInput(inputEntry({ deviceId: 'dB', id: 'same' }));
    const snap = store.acquireExportSnapshot({}); // all devices
    const out = new MemWritable();
    await writeHar(snap, out);
    const har = JSON.parse(out.text());
    expect(har.log.entries).toHaveLength(2);
  });

  it('honors a filtered selection (explicit entryKeys)', async () => {
    const store = new Store();
    store.addEntryInput(inputEntry({ id: 'keep' }));
    store.addEntryInput(inputEntry({ id: 'drop' }));
    const har = await harOf(store, { deviceId: 'd1', entryKeys: [{ deviceId: 'd1', id: 'keep' }] } as any);
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0].request.url).toContain('q=1');
  });

  it('keeps repeated requests separate (no dedup)', async () => {
    const store = new Store();
    store.addEntryInput(inputEntry({ id: 'a', startedAt: 1 }));
    store.addEntryInput(inputEntry({ id: 'b', startedAt: 2 }));
    store.addEntryInput(inputEntry({ id: 'c', startedAt: 3 }));
    const har = await harOf(store);
    expect(har.log.entries).toHaveLength(3);
  });

  it('produces a schema-valid HAR 1.2 log', async () => {
    const store = new Store();
    store.addEntryInput(inputEntry({ id: 'ok' }));
    store.addEntryInput(inputEntry({ id: 'pending', status: null, statusText: '', durationMs: null }));
    store.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'atlantis', url: 'wss://x/live', openedAt: 5, closedAt: null, closeCode: null, closeReason: '', kind: 'websocket', httpEntryKey: null });
    store.appendWsFrame('w1', { ts: 6000, direction: 'in', data: 'hi', size: 2, binary: false }, null, 'd1');
    const har = await harOf(store);
    expect(har.log.version).toBe('1.2');
    expect(typeof har.log.creator.name).toBe('string');
    for (const en of har.log.entries) {
      expect(Number.isNaN(Date.parse(en.startedDateTime))).toBe(false);
      expect(typeof en.time).toBe('number');
      for (const side of ['request', 'response'] as const) {
        expect(Array.isArray(en[side].headers)).toBe(true);
        expect(Array.isArray(en[side].cookies)).toBe(true);
      }
      expect(typeof en.request.method).toBe('string');
      expect(Array.isArray(en.request.queryString)).toBe(true);
      expect(typeof en.response.status).toBe('number');
      expect(typeof en.response.content.size).toBe('number');
      expect(typeof en.response.content.mimeType).toBe('string');
      expect(typeof en.response.redirectURL).toBe('string');
      expect(en.timings).toMatchObject({ send: expect.any(Number), wait: expect.any(Number), receive: expect.any(Number) });
      expect(en.cache).toBeTypeOf('object');
    }
  });
});

describe('Export snapshot — consistency, lease and budget (R5)', () => {
  it('stays consistent when the store is cleared or upserted mid-stream', async () => {
    const store = new Store();
    const bytes = Buffer.from('captured-body', 'utf8');
    store.addEntryInput(inputEntry({ id: 'r1', responseBytes: bytes, responseBodySize: bytes.length }));
    const snap = store.acquireExportSnapshot({ deviceId: 'd1' });
    // Mutate the live store AFTER the snapshot is taken.
    store.clear();
    store.addEntryInput(inputEntry({ id: 'r2' }));
    const out = new MemWritable();
    await writeHar(snap, out);
    const har = JSON.parse(out.text());
    // The snapshot still reflects the record and body it captured, not the new store.
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0].response.content.text).toBe('captured-body');
  });

  it('holds body references while streaming; new capture still respects the budget', async () => {
    // Budget for exactly one 8-byte body. The export pins it; a second capture
    // arriving before release() finds the budget full and is omitted (never a
    // relaxed limit for the sake of the export).
    const store = new Store({ limits: { perBodyBytes: 64, bodyBytes: 8 } });
    const a = Buffer.from('AAAAAAAA', 'utf8'); // 8 bytes, fills the budget
    store.addEntryInput(inputEntry({ id: 'a', responseBytes: a, responseBodySize: 8 }));
    const snap = store.acquireExportSnapshot({ deviceId: 'd1' });
    expect(store.bodyStats().retainedBytes).toBe(8);
    // Clearing the live store would normally free the blob, but the snapshot's
    // reference keeps it retained.
    store.clear();
    expect(store.bodyStats().retainedBytes).toBe(8);
    const b = Buffer.from('BBBBBBBB', 'utf8');
    store.addEntryInput(inputEntry({ id: 'b', responseBytes: b, responseBodySize: 8 }));
    // No room: the new body is omitted for budget, not admitted by relaxing it.
    const bEntry = store.entries('d1').find((e) => e.id === 'b')!;
    expect(bEntry.responseBodyOmitted).toBe('budget');
    // Draining the export releases the pin; the blob is freed.
    const out = new MemWritable();
    await writeHar(snap, out);
    expect(store.bodyStats().retainedBytes).toBe(0);
  });

  it('releases the lease when the writer finishes, and release() is idempotent', async () => {
    const store = new Store();
    const bytes = Buffer.from('body', 'utf8');
    store.addEntryInput(inputEntry({ id: 'r1', responseBytes: bytes, responseBodySize: 4 }));
    const snap = store.acquireExportSnapshot({ deviceId: 'd1' });
    expect(snap.deadlineAt).toBeGreaterThan(Date.now());
    expect(snap.deadlineAt).toBeLessThanOrEqual(Date.now() + EXPORT_LEASE_MS);
    const before = store.bodyStats().references;
    const out = new MemWritable();
    await writeHar(snap, out);
    snap.release(); // second release is a no-op
    expect(store.bodyStats().references).toBe(before - 1);
  });

  it('releases the lease when the consumer aborts mid-stream (within the 30 s cap)', async () => {
    const store = new Store();
    const bytes = Buffer.from('x'.repeat(2000), 'utf8');
    for (let i = 0; i < 20; i++) store.addEntryInput(inputEntry({ id: `r${i}`, startedAt: i, responseBytes: bytes, responseBodySize: 2000 }));
    const baseline = store.bodyStats().references; // the store's own refs (before the snapshot pins)
    const snap = store.acquireExportSnapshot({ deviceId: 'd1' });
    expect(store.bodyStats().references).toBeGreaterThan(baseline); // snapshot added pins
    // A Writable that errors after the first chunk simulates a consumer going away.
    const aborting = new Writable({ highWaterMark: 16, write(_c, _e, cb) { cb(new Error('client gone')); } });
    await expect(writeHar(snap, aborting)).rejects.toThrow();
    // finally released the snapshot's pins despite the abort (store's own refs remain).
    expect(store.bodyStats().references).toBe(baseline);
  });
});

// A minimal HAR 1.2 required-field validator (per the w3c HAR 1.2 spec + the
// har-schema postData rule): enough structure that a standard importer accepts it.
function harErrors(har: any): string[] {
  const errs: string[] = [];
  const req = (o: any, k: string, t: string, p: string) => { if (o?.[k] === undefined) errs.push(`${p}.${k} missing`); else if (typeof o[k] !== t) errs.push(`${p}.${k} not ${t}`); };
  if (har?.log?.version !== '1.2') errs.push('log.version != 1.2');
  if (typeof har?.log?.creator?.name !== 'string') errs.push('creator.name');
  if (!Array.isArray(har?.log?.entries)) { errs.push('entries not array'); return errs; }
  har.log.entries.forEach((e: any, i: number) => {
    const p = `entries[${i}]`;
    req(e, 'startedDateTime', 'string', p); if (Number.isNaN(Date.parse(e.startedDateTime))) errs.push(`${p}.startedDateTime not ISO`);
    req(e, 'time', 'number', p);
    for (const side of ['request', 'response'] as const) {
      if (!Array.isArray(e[side]?.headers)) errs.push(`${p}.${side}.headers not array`);
      if (!Array.isArray(e[side]?.cookies)) errs.push(`${p}.${side}.cookies not array`);
    }
    req(e.request, 'method', 'string', `${p}.request`); req(e.request, 'url', 'string', `${p}.request`);
    if (!Array.isArray(e.request?.queryString)) errs.push(`${p}.request.queryString not array`);
    // har-schema 2.0.0: postData requires mimeType and one of text/params.
    if (e.request?.postData !== undefined) {
      req(e.request.postData, 'mimeType', 'string', `${p}.request.postData`);
      if (e.request.postData.text === undefined && e.request.postData.params === undefined) errs.push(`${p}.request.postData needs text|params`);
    }
    req(e.response, 'status', 'number', `${p}.response`); req(e.response, 'redirectURL', 'string', `${p}.response`);
    req(e.response?.content, 'size', 'number', `${p}.response.content`); req(e.response?.content, 'mimeType', 'string', `${p}.response.content`);
    for (const k of ['send', 'wait', 'receive']) req(e.timings, k, 'number', `${p}.timings`);
  });
  return errs;
}

describe('HAR fixtures — no silent drift (R5 manual-import artifact)', () => {
  for (const sc of scenarios) {
    it(`${sc.file} matches the exporter output and is HAR 1.2 valid`, async () => {
      const rendered = await renderHar(sc.build());
      const committedPath = fileURLToPath(new URL(`./fixtures/har/${sc.file}`, import.meta.url));
      const committed = JSON.parse(readFileSync(committedPath, 'utf8'));
      // The committed artifact must equal a fresh render of its seed — an exporter
      // change that would alter the fixture fails here instead of drifting.
      expect(rendered).toEqual(committed);
      expect(harErrors(committed)).toEqual([]);
    });
  }

  it('the websocket fixture carries the union: linked handshake + synthetic orphan', () => {
    const committedPath = fileURLToPath(new URL('./fixtures/har/websocket.har', import.meta.url));
    const har = JSON.parse(readFileSync(committedPath, 'utf8'));
    expect(har.log.entries).toHaveLength(2);
    const linked = har.log.entries.find((e: any) => e.request.url === 'https://api.example.io/live');
    expect(linked._webSocketMessages).toHaveLength(2);
    expect(linked._webSocketMessages[1].opcode).toBe(2); // binary frame
    const orphan = har.log.entries.find((e: any) => e._terminus?.synthetic);
    expect(orphan.response.status).toBe(0);
    expect(orphan._webSocketMessages).toHaveLength(1);
  });

  it('the http-bodies fixture keeps binary base64 and empty-but-present postData.text', () => {
    const committedPath = fileURLToPath(new URL('./fixtures/har/http-bodies.har', import.meta.url));
    const har = JSON.parse(readFileSync(committedPath, 'utf8'));
    const binResp = har.log.entries.find((e: any) => e.response.content.encoding === 'base64');
    expect(Buffer.from(binResp.response.content.text, 'base64')).toEqual(Buffer.from([0, 255, 195, 40, 1, 2]));
    const binReq = har.log.entries.find((e: any) => e.request.postData?._terminusContent);
    expect(binReq.request.postData.text).toBe(''); // present (schema) but not fabricated
  });
});

describe('JSON export — same bounded snapshot model', () => {
  it('streams { entries, ws } from the snapshot and releases the lease', async () => {
    const store = new Store();
    const bytes = Buffer.from('{"ok":true}', 'utf8');
    store.addEntryInput(inputEntry({ id: 'r1', responseBytes: bytes, responseBodySize: bytes.length }));
    store.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'atlantis', url: 'wss://x/live', openedAt: 1, closedAt: null, closeCode: null, closeReason: '', kind: 'websocket', httpEntryKey: null });
    store.appendWsFrame('w1', { ts: 2, direction: 'in', data: 'hi', size: 2, binary: false }, null, 'd1');
    const baseline = store.bodyStats().references;
    const snap = store.acquireExportSnapshot({ deviceId: 'd1' });
    const out = new MemWritable();
    await writeJson(snap, out);
    const doc = JSON.parse(out.text());
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].responseBody).toBe('{"ok":true}');
    expect(doc.ws).toHaveLength(1);
    expect(doc.ws[0].frames[0].data).toBe('hi');
    expect(store.bodyStats().references).toBe(baseline); // snapshot lease released
  });
});
