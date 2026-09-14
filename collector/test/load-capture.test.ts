import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { Store } from '../src/store.js';
import { writeHar, writeJson } from '../src/har.js';
import { loadCaptureDoc, loadCaptureFile } from '../src/loadCapture.js';
import { parseCollectorArgs } from '../src/mainArgs.js';
import type { Entry } from '../src/types.js';

class MemWritable extends Writable {
  chunks: Buffer[] = [];
  _write(chunk: Buffer, _enc: string, cb: (e?: Error) => void): void { this.chunks.push(Buffer.from(chunk)); cb(); }
  text(): string { return Buffer.concat(this.chunks).toString('utf8'); }
}

async function exportDoc(store: Store, kind: 'har' | 'json'): Promise<any> {
  const snap = store.acquireExportSnapshot({});
  const out = new MemWritable();
  await (kind === 'har' ? writeHar(snap, out) : writeJson(snap, out));
  return JSON.parse(out.text());
}

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'r1', deviceId: 'd1', source: 'atlantis', startedAt: 1_700_000_000_000,
    method: 'POST', url: 'https://api.example.io/v1/x?q=1',
    requestHeaders: { 'content-type': 'application/json' }, requestBody: '{"a":1}', requestBodySize: 7, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":true}', responseBodySize: 11, responseBodyOmitted: null,
    durationMs: 42, error: null, ...over,
  };
}

describe('JSON export round-trip (T7.3)', () => {
  it('export -> load reproduces entries with source, deviceId and text bodies', async () => {
    const src = new Store();
    src.addEntry(entry({ id: 'a', source: 'xhr', startedAt: 1 }));
    src.addEntry(entry({ id: 'b', source: 'proxy', startedAt: 2, method: 'GET', requestBody: null, requestBodySize: 0 }));
    src.addEntry(entry({ id: 'c', deviceId: 'd2', source: 'replay', startedAt: 3, replayOf: { id: 'a' } }));

    const doc = await exportDoc(src, 'json');
    const dst = new Store();
    const summary = loadCaptureDoc(dst, doc, 'cap.json');
    expect(summary.entries).toBe(3);

    const norm = (s: Store) => s.entries().map((e) => ({
      id: e.id, deviceId: e.deviceId, source: e.source, method: e.method, url: e.url,
      status: e.status, requestBody: e.requestBody, responseBody: e.responseBody, replayOf: e.replayOf,
    }));
    expect(norm(dst)).toEqual(norm(src));
    // Synthetic devices were created for both device ids.
    expect(dst.devices().map((d) => d.deviceId).sort()).toEqual(['d1', 'd2']);
  });

  it('round-trips a WebSocket session with its text frames', async () => {
    const src = new Store();
    src.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'atlantis', url: 'wss://api.example.io/live', openedAt: 10, closedAt: null, closeCode: null, closeReason: '', kind: 'websocket', httpEntryKey: null });
    src.appendWsFrame('w1', { ts: 11, direction: 'out', data: 'hello', size: 5, binary: false }, null, 'd1');
    src.appendWsFrame('w1', { ts: 12, direction: 'in', data: 'world', size: 5, binary: false }, null, 'd1');
    src.closeWs('w1', 13, 1000, 'done', 'd1');

    const doc = await exportDoc(src, 'json');
    const dst = new Store();
    const summary = loadCaptureDoc(dst, doc, 'cap.json');
    expect(summary.sessions).toBe(1);
    expect(summary.frames).toBe(2);

    const s = dst.wsSessions('d1')[0];
    expect(s.source).toBe('atlantis');
    expect(s.closeCode).toBe(1000);
    expect(s.frames.map((f) => [f.direction, f.data])).toEqual([['out', 'hello'], ['in', 'world']]);
  });
});

describe('HAR round-trip (T7.3)', () => {
  it('recovers a captured binary response body via base64', async () => {
    const bin = Buffer.from([0, 255, 195, 40, 1, 2]);
    const src = new Store();
    src.addEntryInput({
      id: 'r1', deviceId: 'd1', source: 'atlantis', startedAt: 1_700_000_000_000,
      method: 'GET', url: 'https://api.example.io/blob',
      requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
      status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/octet-stream' },
      responseBytes: bin, responseBodySize: bin.length, responseBodyOmitted: 'binary',
      durationMs: 5, error: null,
    });

    const doc = await exportDoc(src, 'har');
    const dst = new Store();
    loadCaptureFileDoc(dst, doc);
    // A Terminus HAR carries the entry's identity (T9), so it lands on the real
    // device/id it was captured under — not the synthetic `har:<basename>` device.
    const imported = dst.entries('d1');
    expect(imported).toHaveLength(1);
    expect(imported[0].id).toBe('r1');
    expect(imported[0].source).toBe('atlantis');
    expect(imported[0].method).toBe('GET');
    expect(imported[0].url).toBe('https://api.example.io/blob');
    const body = dst.entryBody('d1', imported[0].id, 'response');
    expect(body?.state).toBe('captured');
    expect(Buffer.from(body!.bytes!)).toEqual(bin);
  });

  it('recovers a WebSocket session, preserving source and deviceId from the extension', async () => {
    const src = new Store();
    src.addEntryInput({
      id: 'hs', deviceId: 'd1', source: 'atlantis', startedAt: 1_700_000_000_000,
      method: 'GET', url: 'https://api.example.io/live',
      requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
      status: 101, statusText: 'Switching Protocols', responseHeaders: {}, responseBytes: null, responseBodySize: 0, responseBodyOmitted: null,
      durationMs: null, error: null,
    });
    src.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'atlantis', url: 'wss://api.example.io/live', openedAt: 1_700_000_000_000, closedAt: null, closeCode: null, closeReason: '', kind: 'websocket', httpEntryKey: { deviceId: 'd1', id: 'hs' } });
    src.appendWsFrame('w1', { ts: 1_700_000_001_000, direction: 'out', data: 'ping', size: 4, binary: false }, null, 'd1');
    src.closeWs('w1', 1_700_000_002_000, 1000, 'bye', 'd1');

    const doc = await exportDoc(src, 'har');
    const dst = new Store();
    loadCaptureFileDoc(dst, doc);
    const s = dst.wsSessions('d1').find((x) => x.wsId === 'w1');
    expect(s).toBeTruthy();
    expect(s!.source).toBe('atlantis');
    expect(s!.frames.map((f) => f.data)).toEqual(['ping']);
    expect(s!.closeCode).toBe(1000);
  });

  it('imports a third-party HAR (no _terminus) onto a har:<basename> device', () => {
    const har = {
      log: {
        version: '1.2', creator: { name: 'chrome', version: '1' },
        entries: [{
          startedDateTime: new Date(1_700_000_000_000).toISOString(), time: 12,
          request: { method: 'GET', url: 'https://third.example/api', httpVersion: 'HTTP/1.1', cookies: [], headers: [{ name: 'accept', value: 'application/json' }], queryString: [], headersSize: -1, bodySize: 0 },
          response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', cookies: [], headers: [], content: { size: 2, mimeType: 'application/json', text: '{}' }, redirectURL: '', headersSize: -1, bodySize: 2 },
          cache: {}, timings: { send: 0, wait: 12, receive: 0 },
        }],
      },
    };
    const dst = new Store();
    const summary = loadCaptureDoc(dst, har, 'third.har');
    expect(summary.entries).toBe(1);
    const imported = dst.entries('har:third.har');
    expect(imported[0].url).toBe('https://third.example/api');
    expect(imported[0].requestHeaders.accept).toBe('application/json');
    expect(imported[0].responseBody).toBe('{}');
  });

  it('rejects an unrecognized document', () => {
    expect(() => loadCaptureDoc(new Store(), { nope: true }, 'x')).toThrow(/unrecognized/);
  });
});

// T9.3: a HAR export of a store with entries from several devices/sources and
// text/binary/omitted bodies (plus a replay carrying `replayOf`) → `--load` into a
// fresh store reproduces the same set: deviceId, id, source, method, url, status,
// headers, recoverable bodies, and replayOf — no synthetic `har:*` device.
describe('HAR lossless round-trip (T9.3)', () => {
  const bin = Buffer.from([0, 255, 195, 40, 1, 2]);

  function seed(): Store {
    const s = new Store();
    // d1: text bodies (xhr), captured binary response (atlantis), omitted response (proxy).
    s.addEntryInput({
      id: 'e-text', deviceId: 'd1', source: 'xhr', startedAt: 1_700_000_000_000,
      method: 'POST', url: 'https://api.example.io/a?q=1',
      requestHeaders: { 'content-type': 'application/json', accept: '*/*' }, requestBytes: Buffer.from('{"a":1}', 'utf8'), requestBodySize: 7, requestBodyOmitted: null,
      status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/json' }, responseBytes: Buffer.from('{"ok":true}', 'utf8'), responseBodySize: 11, responseBodyOmitted: null,
      durationMs: 12, error: null,
    });
    s.addEntryInput({
      id: 'e-bin', deviceId: 'd1', source: 'atlantis', startedAt: 1_700_000_000_100,
      method: 'GET', url: 'https://api.example.io/blob',
      requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
      status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/octet-stream' }, responseBytes: bin, responseBodySize: bin.length, responseBodyOmitted: 'binary',
      durationMs: 5, error: null,
    });
    s.addEntryInput({
      id: 'e-omit', deviceId: 'd1', source: 'proxy', startedAt: 1_700_000_000_200,
      method: 'GET', url: 'https://api.example.io/big',
      requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
      status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/octet-stream' }, responseBytes: null, responseBodySize: 5_000_000, responseBodyOmitted: 'size',
      durationMs: 9, error: null,
    });
    // d2: a replay entry with a back-reference.
    s.addEntryInput({
      id: 'e-replay', deviceId: 'd2', source: 'replay', startedAt: 1_700_000_000_300,
      method: 'POST', url: 'https://api.example.io/a?q=1',
      requestHeaders: { 'content-type': 'application/json' }, requestBytes: Buffer.from('{"a":1}', 'utf8'), requestBodySize: 7, requestBodyOmitted: null,
      status: 201, statusText: 'Created', responseHeaders: { 'content-type': 'application/json' }, responseBytes: Buffer.from('{"ok":1}', 'utf8'), responseBodySize: 8, responseBodyOmitted: null,
      replayOf: { id: 'e-text' },
      durationMs: 7, error: null,
    });
    return s;
  }

  type Norm = { id: string; deviceId: string; source: string; method: string; url: string; status: number | null; reqCt?: string; respState?: string; respBytes?: string; replayOf?: { id: string } };
  function norm(store: Store): Norm[] {
    return store.entries().map((e): Norm => {
      const body = store.entryBody(e.deviceId, e.id, 'response');
      return {
        id: e.id, deviceId: e.deviceId, source: e.source, method: e.method, url: e.url, status: e.status,
        reqCt: e.requestHeaders['content-type'], respState: body?.state,
        respBytes: body?.bytes ? Buffer.from(body.bytes).toString('base64') : undefined,
        replayOf: e.replayOf,
      };
    }).sort((a, b) => (a.deviceId + a.id).localeCompare(b.deviceId + b.id));
  }

  it('reproduces deviceId, id, source, method, url, status, headers, bodies and replayOf', async () => {
    const src = seed();
    const doc = await exportDoc(src, 'har');
    const dst = new Store();
    const summary = loadCaptureDoc(dst, doc, 'cap.har');
    expect(summary.entries).toBe(4);
    expect(norm(dst)).toEqual(norm(src));
    // Devices are the real ones, never a synthetic har:<basename> device.
    expect(dst.devices().map((d) => d.deviceId).sort()).toEqual(['d1', 'd2']);
    // The omitted body stays omitted (not fabricated) through the round-trip.
    expect(dst.entryBody('d1', 'e-omit', 'response')?.state).toBe('omitted');
    // The captured binary is recovered byte-for-byte.
    expect(Buffer.from(dst.entryBody('d1', 'e-bin', 'response')!.bytes!)).toEqual(bin);
    // The replay back-reference survives.
    expect(dst.entries('d2').find((e) => e.id === 'e-replay')!.replayOf).toEqual({ id: 'e-text' });
  });
});

// Helper: HAR fixtures in these tests use the basename 'cap.har'.
function loadCaptureFileDoc(store: Store, doc: unknown): void {
  loadCaptureDoc(store, doc, 'cap.har');
}

describe('parseCollectorArgs (T7.3)', () => {
  it('collects repeatable --load, --help and --version', () => {
    expect(parseCollectorArgs(['--load', 'a.har', '--load=b.json'])).toMatchObject({ loads: ['a.har', 'b.json'], help: false, version: false });
    expect(parseCollectorArgs(['--help']).help).toBe(true);
    expect(parseCollectorArgs(['-V']).version).toBe(true);
  });
  it('flags a --load with no path and reports unknown tokens', () => {
    const a = parseCollectorArgs(['--load', '--help']);
    expect(a.help).toBe(true);
    expect(a.unknown).toContain('--load (missing path)');
    expect(parseCollectorArgs(['--frobnicate']).unknown).toEqual(['--frobnicate']);
  });
});

describe('loadCaptureFile error paths (T7.3)', () => {
  it('throws a path-tagged error for a missing file', () => {
    expect(() => loadCaptureFile(new Store(), '/no/such/file.har')).toThrow(/--load .*cannot read/);
  });
});
