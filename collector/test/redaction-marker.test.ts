import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { Store } from '../src/store.js';
import type { EntrySummary } from '../src/uiProtocol.js';
import { decodeAtlantis } from '../src/atlantis/decode.js';
import { buildEntryInput } from '../src/proxy/normalize.js';
import { CAPABILITIES } from '../src/version.js';
import { writeHar, writeJson } from '../src/har.js';
import { loadCaptureDoc } from '../src/loadCapture.js';
import { createCollectorHarness, type CollectorHarness } from './fixtures/harness.js';
import { apply, completedInner, startInner, envelopePayload } from './fixtures/atlantisWire.js';

// P5: the per-side `redacted` marker on every HTTP entry, and redaction before
// hashing/storage on the three ingest paths (Atlantis, proxy, WSS).

const b64 = (s: string) => Buffer.from(s).toString('base64');
const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const summary = (store: Store, deviceId: string, id: string): EntrySummary =>
  store.snapshotEntrySummaries().find((e) => e.deviceId === deviceId && e.id === id)!;
const DEV = 'com.acme.app-Pixel';

describe('redacted marker: Atlantis', () => {
  it('false/false for a clean exchange', () => {
    const store = new Store();
    apply(store, DEV, 'traffic', completedInner('t1'));
    expect(summary(store, DEV, 't1').redacted).toEqual({ request: false, response: false });
  });
  it('request-only true (query, header or body)', () => {
    for (const over of [
      { request: { url: 'https://api.example/x?API_KEY=k', method: 'GET', headers: [], body: null } },
      { request: { url: 'https://api.example/x', method: 'GET', headers: [{ key: 'X-Session-Id', value: 's' }], body: null } },
      { request: { url: 'https://api.example/x', method: 'POST', headers: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }], body: b64('username=a&password=b') } },
    ]) {
      const store = new Store();
      apply(store, DEV, 'traffic', completedInner('t1', over));
      expect(summary(store, DEV, 't1').redacted).toEqual({ request: true, response: false });
    }
  });
  it('response-only true (header or body)', () => {
    for (const over of [
      { response: { statusCode: 200, headers: [{ key: 'Set-Cookie', value: 'a=b' }] } },
      { responseBodyData: b64('{"user":{"profile":{"cardNumber":"4111"}}}') },
    ]) {
      const store = new Store();
      apply(store, DEV, 'traffic', completedInner('t1', over));
      expect(summary(store, DEV, 't1').redacted).toEqual({ request: false, response: true });
    }
  });
  it('a request-start packet followed by its completion keeps the request-side true', () => {
    const store = new Store();
    apply(store, DEV, 'traffic', { ...startInner('t1'), request: { url: 'https://api.example/t1?token=t', method: 'POST', headers: [], body: b64('req') } });
    expect(summary(store, DEV, 't1').redacted).toEqual({ request: true, response: false });
    // The completion re-sends a clean request (e.g. the token was only on the start)
    // and a sensitive response: both sides end true.
    apply(store, DEV, 'traffic', completedInner('t1', { responseBodyData: b64('{"otp":1}') }));
    expect(summary(store, DEV, 't1').redacted).toEqual({ request: true, response: true });
  });
  it('redacts before the body is hashed and stored', () => {
    const ev = decodeAtlantis(envelopePayload(DEV, 'traffic', completedInner('t1', { responseBodyData: b64('{"password":"hunter2"}') })));
    if (ev?.kind !== 'traffic') throw new Error('kind');
    const store = new Store();
    store.addEntryInput(ev.entry);
    const ref = summary(store, ev.entry.deviceId, 't1').responseBody;
    expect(ref.sha256).toBe(sha('{"password":"***"}'));
    expect(store.entry(ev.entry.deviceId, 't1')!.responseBody).toBe('{"password":"***"}');
  });
});

describe('redacted marker: proxy', () => {
  const ids = { id: 'proxy:s:r1', deviceId: 'proxy:s:c1' };
  it('marks each side and redacts before hashing', () => {
    const store = new Store();
    store.addEntryInput(buildEntryInput({ ids, startedAt: 1, method: 'POST', url: 'https://h.test/login',
      requestHeaders: { 'content-type': 'application/json' }, requestBuf: Buffer.from('{"items":[{"pin":"1234"}]}') }));
    expect(summary(store, ids.deviceId, ids.id).redacted).toEqual({ request: true, response: false });
    store.addEntryInput(buildEntryInput({ ids, startedAt: 1, method: 'POST', url: 'https://h.test/login',
      requestHeaders: { 'content-type': 'application/json' }, requestBuf: Buffer.from('{"items":[{"pin":"1234"}]}'),
      status: 200, responseHeaders: { 'x-amz-security-token': 't' }, responseBuf: Buffer.from('ok') }));
    const s = summary(store, ids.deviceId, ids.id);
    expect(s.redacted).toEqual({ request: true, response: true });
    expect(s.requestBody.sha256).toBe(sha('{"items":[{"pin":"***"}]}'));
  });
  it('false/false for a clean proxied exchange', () => {
    const store = new Store();
    store.addEntryInput(buildEntryInput({ ids, startedAt: 1, method: 'GET', url: 'https://h.test/?page=2', status: 200, responseBuf: Buffer.from('{"a":1}') }));
    expect(summary(store, ids.deviceId, ids.id).redacted).toEqual({ request: false, response: false });
  });
});

describe('redacted marker: WSS (XHR request then response)', () => {
  it('keeps the request-side true across the response patch and redacts before hashing', () => {
    const store = new Store();
    store.applyDeviceMessage('d1', { type: 'request', id: 'x1', ts: 1, method: 'POST', url: 'https://h.test/login',
      headers: { 'content-type': 'application/json' }, body: '{"password":"p"}', bodySize: 16 } as never);
    expect(summary(store, 'd1', 'x1').redacted).toEqual({ request: true, response: false });
    store.applyDeviceMessage('d1', { type: 'response', id: 'x1', ts: 2, status: 200, statusText: 'OK',
      headers: { 'content-type': 'application/json' }, body: '{"ok":true}', bodySize: 11, durationMs: 1 } as never);
    const s = summary(store, 'd1', 'x1');
    expect(s.redacted).toEqual({ request: true, response: false });
    expect(s.requestBody.sha256).toBe(sha('{"password":"***"}'));
  });
  it('response-only true', () => {
    const store = new Store();
    store.applyDeviceMessage('d1', { type: 'request', id: 'x1', ts: 1, method: 'GET', url: 'https://h.test/me', headers: {}, body: null, bodySize: 0 } as never);
    store.applyDeviceMessage('d1', { type: 'response', id: 'x1', ts: 2, status: 200, statusText: 'OK',
      headers: {}, body: '{"session":{"id":"s"}}', bodySize: 22, durationMs: 1 } as never);
    expect(summary(store, 'd1', 'x1').redacted).toEqual({ request: false, response: true });
    expect(store.entry('d1', 'x1')!.responseBody).toBe('{"session":"***"}');
  });
});

describe('redacted marker on the read API', () => {
  async function withHarness(fn: (h: CollectorHarness, get: (p: string) => Promise<Response>) => Promise<void>): Promise<void> {
    const h = await createCollectorHarness();
    try {
      const get = (p: string) => fetch(h.url + p, { headers: { authorization: `Bearer ${h.adminToken}` } });
      await fn(h, get);
    } finally { await h.close(); }
  }
  const seed = (store: Store) => {
    apply(store, DEV, 'traffic', completedInner('clean'));
    apply(store, DEV, 'traffic', completedInner('dirty', { request: { url: 'https://api.example/x?token=t', method: 'GET', headers: [], body: null } }));
  };
  const byId = (items: EntrySummary[]) => Object.fromEntries(items.map((e) => [e.id, e.redacted]));
  const expected = { clean: { request: false, response: false }, dirty: { request: true, response: false } };

  it('afterSeq, last, cursor mode, detail and wait all carry it', () => withHarness(async (h, get) => {
    seed(h.store);
    expect(byId((await (await get('/api/entries?afterSeq=0')).json()).items)).toEqual(expected);
    expect(byId((await (await get('/api/entries?last=2')).json()).items)).toEqual(expected);
    expect(byId((await (await get('/api/entries')).json()).items)).toEqual(expected);
    expect(byId((await (await get('/api/entries/wait?afterSeq=0&limit=2&timeoutMs=1000')).json()).items)).toEqual(expected);
    const dev = h.store.snapshotEntrySummaries()[0].deviceId;
    const detail = await (await get(`/api/entries/${encodeURIComponent(dev)}/dirty`)).json();
    expect(detail.redacted).toEqual({ request: true, response: false });
  }));
});

describe('redacted marker in exports', () => {
  class Mem extends Writable {
    chunks: Buffer[] = [];
    override _write(c: Buffer, _e: BufferEncoding, cb: () => void) { this.chunks.push(Buffer.from(c)); cb(); }
    text() { return Buffer.concat(this.chunks).toString('utf8'); }
  }
  const seeded = () => {
    const store = new Store();
    apply(store, DEV, 'traffic', completedInner('clean'));
    apply(store, DEV, 'traffic', completedInner('dirty', { responseBodyData: b64('{"token":"t"}') }));
    return store;
  };
  it('HAR carries _terminus.redacted only when something was masked, and import restores it', async () => {
    const store = seeded();
    const out = new Mem();
    await writeHar(store.acquireExportSnapshot({ deviceId: DEV }), out);
    const har = JSON.parse(out.text());
    const ext = Object.fromEntries(har.log.entries.map((e: { _terminus: { id: string; redacted?: unknown } }) => [e._terminus.id, e._terminus.redacted]));
    expect(ext).toEqual({ clean: undefined, dirty: { request: false, response: true } });
    const back = new Store();
    loadCaptureDoc(back, har, 'x.har');
    expect(summary(back, DEV, 'dirty').redacted).toEqual({ request: false, response: true });
    expect(summary(back, DEV, 'clean').redacted).toEqual({ request: false, response: false });
  });
  it('JSON export carries it on the entry and import restores it', async () => {
    const out = new Mem();
    await writeJson(seeded().acquireExportSnapshot({ deviceId: DEV }), out);
    const doc = JSON.parse(out.text());
    expect(doc.entries.find((e: { id: string }) => e.id === 'dirty').redacted).toEqual({ request: false, response: true });
    const back = new Store();
    loadCaptureDoc(back, doc, 'x.json');
    expect(summary(back, DEV, 'dirty').redacted).toEqual({ request: false, response: true });
  });
});

describe('capabilities', () => {
  it('advertises redaction-marker', () => { expect(CAPABILITIES).toContain('redaction-marker'); });
});
