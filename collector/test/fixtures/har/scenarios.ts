// Single source of truth for the on-disk HAR fixtures. The committed *.har files
// are regenerated from these exact scenarios, and `har-roundtrip.test.ts` renders
// them again and diffs against the committed files — so any exporter change that
// would alter a fixture breaks the suite loudly instead of letting the artifact
// (which the manual-DevTools-import step rests on) silently drift.
import { Writable } from 'node:stream';
import { Store } from '../../../src/store.js';
import { writeHar } from '../../../src/har.js';
import type { EntryInput } from '../../../src/types.js';

export const ei = (o: Partial<EntryInput>): EntryInput => ({
  id: 'r', deviceId: 'd1', source: 'atlantis', startedAt: 1_700_000_000_000,
  method: 'POST', url: 'https://api.example.io/v1/x?q=1',
  requestHeaders: { 'content-type': 'application/json' }, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
  status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/json' },
  responseBytes: null, responseBodySize: 0, responseBodyOmitted: null, durationMs: 42, error: null, ...o,
});

export type Scenario = { file: string; build: () => Store };

// Mixed bodies: text (non-ASCII), captured binary response, captured binary
// request, an omission with a known original size, and a pending exchange.
function httpBodies(): Store {
  const s = new Store();
  const j = Buffer.from('{"ok":true,"msg":"héllo 世界"}', 'utf8');
  s.addEntryInput(ei({ id: 'text', responseBytes: j, responseBodySize: j.length }));
  const bin = Buffer.from([0, 255, 195, 40, 1, 2]);
  s.addEntryInput(ei({ id: 'binResp', startedAt: 1_700_000_000_100, responseHeaders: { 'content-type': 'application/octet-stream' }, responseBytes: bin, responseBodySize: bin.length, responseBodyOmitted: 'binary' }));
  const rb = Buffer.from([9, 8, 250, 0]);
  s.addEntryInput(ei({ id: 'binReq', startedAt: 1_700_000_000_200, requestHeaders: { 'content-type': 'application/protobuf' }, requestBytes: rb, requestBodySize: rb.length, requestBodyOmitted: 'binary' }));
  s.addEntryInput(ei({ id: 'omitted', startedAt: 1_700_000_000_300, responseBytes: null, responseBodyOmitted: 'size', responseBodySize: 5_000_000 }));
  s.addEntryInput(ei({ id: 'pending', startedAt: 1_700_000_000_400, status: null, statusText: '', durationMs: null }));
  return s;
}

// A linked WS handshake (frames attached, not duplicated), a binary frame, a
// close, and a second unlinked socket rendered as a synthetic entry.
function websocket(): Store {
  const s = new Store();
  s.addEntryInput(ei({ id: 'hs', method: 'GET', url: 'https://api.example.io/live', status: 101, statusText: 'Switching Protocols' }));
  s.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'atlantis', url: 'wss://api.example.io/live', openedAt: 1_700_000_000_000, closedAt: null, closeCode: null, closeReason: '', kind: 'websocket', httpEntryKey: { deviceId: 'd1', id: 'hs' } });
  s.appendWsFrame('w1', { ts: 1_700_000_001_000, direction: 'out', data: 'hello', size: 5, binary: false }, null, 'd1');
  const fb = Buffer.from([1, 2, 3, 254]);
  s.appendWsFrame('w1', { ts: 1_700_000_001_500, direction: 'in', data: null, size: fb.length, binary: true }, fb, 'd1');
  s.closeWs('w1', 1_700_000_002_000, 1000, 'done', 'd1');
  s.addWsSession({ wsId: 'w2', deviceId: 'd1', source: 'atlantis', url: 'wss://api.example.io/orphan', openedAt: 1_700_000_003_000, closedAt: null, closeCode: null, closeReason: '', kind: 'websocket', httpEntryKey: null });
  s.appendWsFrame('w2', { ts: 1_700_000_003_100, direction: 'in', data: 'orphan-msg', size: 10, binary: false }, null, 'd1');
  return s;
}

// An SSE stream: its own extension, no WS opcodes.
function sse(): Store {
  const s = new Store();
  s.addWsSession({ wsId: 's1', deviceId: 'd1', source: 'atlantis', url: 'https://api.example.io/sse', openedAt: 1_700_000_000_000, closedAt: null, closeCode: null, closeReason: '', kind: 'sse', httpEntryKey: null });
  s.appendWsFrame('s1', { ts: 1_700_000_000_500, direction: 'in', data: 'data: tick 1\n\n', size: 13, binary: false }, null, 'd1');
  s.appendWsFrame('s1', { ts: 1_700_000_001_000, direction: 'in', data: 'data: tick 2\n\n', size: 13, binary: false }, null, 'd1');
  return s;
}

export const scenarios: Scenario[] = [
  { file: 'http-bodies.har', build: httpBodies },
  { file: 'websocket.har', build: websocket },
  { file: 'sse.har', build: sse },
];

class Collect extends Writable {
  chunks: Buffer[] = [];
  _write(chunk: Buffer, _enc: string, cb: () => void): void { this.chunks.push(Buffer.from(chunk)); cb(); }
  text(): string { return Buffer.concat(this.chunks).toString('utf8'); }
}

// Render a whole store to a parsed HAR object (all devices).
export async function renderHar(store: Store): Promise<any> {
  const snap = store.acquireExportSnapshot({});
  const out = new Collect();
  await writeHar(snap, out);
  return JSON.parse(out.text());
}
