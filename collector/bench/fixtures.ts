// Deterministic synthetic fixtures for the Terminus load / resource baseline.
//
// NOTHING here is real capture data. Every URL, header, body, id and timestamp is
// generated from a fixed seed so a run is byte-for-byte repeatable. Never feed real
// device traffic through the bench: the hosts are `bench.invalid`, the tokens are
// obviously fake (`Bearer bench-…`) and exist only to exercise the redactor.
import { gzipSync } from 'node:zlib';
import type { DeviceMessage } from '../src/types.js';

// --- deterministic PRNG (mulberry32) -------------------------------------
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- deterministic bodies ------------------------------------------------
// The four required body sizes. 1 MiB is the global per-body cap.
export const BODY_SIZES = [0, 1024, 64 * 1024, 1024 * 1024] as const;

// Printable, valid UTF-8 (kept as text by the decoder). Deterministic from seed.
export function utf8Body(size: number, seed: number): Buffer {
  if (size === 0) return Buffer.alloc(0);
  const b = Buffer.allocUnsafe(size);
  const r = rng(seed);
  for (let i = 0; i < size; i++) b[i] = 0x20 + Math.floor(r() * 0x5e); // 0x20..0x7d
  return b;
}

// Binary body: contains NUL bytes so the decoder flags it `binary` (kept out of text).
export function binaryBody(size: number, seed: number): Buffer {
  if (size === 0) return Buffer.alloc(0);
  const b = Buffer.allocUnsafe(size);
  const r = rng(seed);
  for (let i = 0; i < size; i++) b[i] = Math.floor(r() * 256);
  b[Math.min(3, size - 1)] = 0; // guarantee a NUL
  return b;
}

// Server-sent-events style body (captured as an HTTP text/event-stream response).
export function sseBody(events: number, seed: number): Buffer {
  const r = rng(seed);
  let s = '';
  for (let i = 0; i < events; i++) s += `id: ${i}\nevent: tick\ndata: {"n":${Math.floor(r() * 1e6)}}\n\n`;
  return Buffer.from(s, 'utf8');
}

// Highly compressible payload: expands ~1000x under gunzip (expansive-gzip scenario).
export function expansiveBody(size: number): Buffer { return Buffer.alloc(size, 0x41); }

export const deviceId = (n: number): string => `bench-dev-${n}`;

// A small fixed pool of synthetic endpoints so "legitimate repeated requests"
// (same method+url+body, no dedup expected) occur naturally.
const HTTP_PATHS = ['/v1/alpha', '/v1/beta', '/v1/gamma', '/v1/delta'];
const METHODS = ['GET', 'POST', 'PUT'];

export type FixtureKind = 'http' | 'ws' | 'sse';
export type FixtureEvent = {
  device: string; kind: FixtureKind; id: string;
  method: string; url: string; status: number;
  reqBody: Buffer; reqBinary: boolean;
  resBody: Buffer; resBinary: boolean;
  startAtSec: number; durationMs: number;
  wsFrames: { dir: 'in' | 'out'; data: Buffer; binary: boolean }[];
};

// Deterministic base epoch (seconds) — fixed so timestamps never depend on the clock.
const BASE_SEC = 1_700_000_000;
export const BASE_MS = BASE_SEC * 1000;

// Build one deterministic event. `seq` is the global sequence number, `bodyBias`
// lets scenarios force a body-size distribution (e.g. all 1 MiB).
export function makeEvent(device: string, seq: number, opts: { kind?: FixtureKind; bodyBias?: number } = {}): FixtureEvent {
  const r = rng(seq * 2654435761);
  const kind: FixtureKind = opts.kind ?? (seq % 9 === 0 ? 'ws' : seq % 5 === 0 ? 'sse' : 'http');
  // Realistic small-skewed default distribution so a sustained run is not dominated
  // by 1 MiB bodies (which would blow past retention). All four required sizes still
  // occur; size-specific scenarios pass `bodyBias` to force an exact size.
  const defaultIdx = seq % 50 === 49 ? 3 : seq % 5 === 4 ? 2 : seq % 2 === 1 ? 1 : 0;
  const sizeIdx = opts.bodyBias ?? defaultIdx;
  const size = BODY_SIZES[sizeIdx];
  const binary = seq % 4 === 3; // deterministic UTF-8 / binary mix
  const path = HTTP_PATHS[seq % HTTP_PATHS.length];
  const method = METHODS[seq % METHODS.length];
  const mkBody = (n: number, sd: number) => (binary ? binaryBody(n, sd) : utf8Body(n, sd));

  if (kind === 'ws') {
    const frames = Array.from({ length: 8 }, (_, i) => ({
      dir: (i % 2 === 0 ? 'in' : 'out') as 'in' | 'out',
      data: i % 3 === 2 ? binaryBody(256, seq + i) : utf8Body(256, seq + i),
      binary: i % 3 === 2,
    }));
    return { device, kind, id: `${device}-ws-${seq}`, method: 'GET', url: `wss://bench.invalid/socket?room=${seq % 7}`,
      status: 101, reqBody: Buffer.alloc(0), reqBinary: false, resBody: Buffer.alloc(0), resBinary: false,
      startAtSec: BASE_SEC + seq * 0.02, durationMs: 0, wsFrames: frames };
  }
  if (kind === 'sse') {
    return { device, kind, id: `${device}-sse-${seq}`, method: 'GET', url: `https://bench.invalid/stream/events?ch=${seq % 3}`,
      status: 200, reqBody: Buffer.alloc(0), reqBinary: false, resBody: sseBody(16, seq), resBinary: false,
      startAtSec: BASE_SEC + seq * 0.02, durationMs: 5 + Math.floor(r() * 40), wsFrames: [] };
  }
  return { device, kind, id: `${device}-http-${seq}`, method, url: `https://bench.invalid${path}?page=${seq % 11}`,
    status: [200, 201, 204, 404, 500][seq % 5], reqBody: method === 'GET' ? Buffer.alloc(0) : mkBody(size, seq),
    reqBinary: method !== 'GET' && binary, resBody: mkBody(size, seq + 1), resBinary: binary,
    startAtSec: BASE_SEC + seq * 0.02, durationMs: 1 + Math.floor(r() * 250), wsFrames: [] };
}

// --- own-protocol (legacy WSS) materialisation ---------------------------
const FAKE_HEADERS = (i: number): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: `Bearer bench-${i.toString(16).padStart(8, '0')}`, // fake token → redactor
  'x-bench-seq': String(i),
});

export function helloMessage(device: string): DeviceMessage {
  return { type: 'hello', deviceId: device, platform: device.endsWith('0') ? 'android' : 'ios',
    appVersion: '0.0.0-bench', buildProfile: 'bench', dropped: 0, ts: BASE_SEC * 1000 };
}

export function toDeviceMessages(e: FixtureEvent, seq: number): DeviceMessage[] {
  const ts = Math.round(e.startAtSec * 1000);
  const bodyStr = (b: Buffer, bin: boolean) => (bin ? null : b.toString('utf8'));
  if (e.kind === 'ws') {
    const out: DeviceMessage[] = [{ type: 'ws_open', wsId: e.id, ts, url: e.url, protocols: [] }];
    e.wsFrames.forEach((f, i) => out.push({ type: 'ws_frame', wsId: e.id, ts: ts + i,
      direction: f.dir, data: f.binary ? null : f.data.toString('utf8'), size: f.data.length, binary: f.binary }));
    out.push({ type: 'ws_close', wsId: e.id, ts: ts + 100, code: 1000, reason: 'done' });
    return out;
  }
  return [
    { type: 'request', id: e.id, ts, method: e.method, url: e.url, headers: FAKE_HEADERS(seq),
      body: bodyStr(e.reqBody, e.reqBinary), bodySize: e.reqBody.length,
      ...(e.reqBinary ? { bodyOmitted: 'binary' as const } : {}), source: 'xhr' },
    { type: 'response', id: e.id, ts: ts + e.durationMs, status: e.status, statusText: '',
      headers: e.kind === 'sse' ? { 'content-type': 'text/event-stream' } : FAKE_HEADERS(seq),
      body: bodyStr(e.resBody, e.resBinary), bodySize: e.resBody.length,
      ...(e.resBinary ? { bodyOmitted: 'binary' as const } : {}), durationMs: e.durationMs },
  ];
}

// --- Atlantis (TLS v2) materialisation -----------------------------------
type Kv = { key: string; value: string };
const kv = (h: Record<string, string>): Kv[] => Object.entries(h).map(([key, value]) => ({ key, value }));

// Length-prefixed (8-byte LE) frame, optionally gzip-compressed like a real client.
export function atlantisFrame(envelope: unknown, gzip = true): Buffer {
  const json = Buffer.from(JSON.stringify(envelope), 'utf8');
  const payload = gzip ? gzipSync(json) : json;
  const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(payload.length));
  return Buffer.concat([h, payload]);
}

function envelope(id: string, messageType: string, inner: unknown) {
  return { id, messageType, content: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64'), buildVersion: '1.0-bench' };
}

export function atlantisConnection(device: string): unknown {
  return envelope(device, 'connection', {
    device: { name: 'bench', model: device.endsWith('0') ? 'Pixel Bench (Android 14)' : 'iPhoneBench,1' },
    project: { name: 'bench', bundleIdentifier: 'invalid.bench' }, appVersion: '0.0.0-bench', passcode: null });
}

// Materialise a fixture event into one or more Atlantis envelopes (pre-framing).
export function toAtlantisEnvelopes(e: FixtureEvent, seq: number): unknown[] {
  const b64 = (b: Buffer) => (b.length ? b.toString('base64') : null);
  if (e.kind === 'ws') {
    const traffic = envelope(e.device, 'traffic', { id: e.id, startAt: e.startAtSec, endAt: null, packageType: 'websocket',
      request: { url: e.url, method: 'GET', headers: kv(FAKE_HEADERS(seq)) }, response: null, responseBodyData: null, error: null });
    const frames = e.wsFrames.map((f, i) => envelope(e.device, 'websocket', {
      id: e.id, startAt: e.startAtSec, packageType: 'websocket', request: { url: e.url, method: 'GET', headers: [] },
      websocketMessagePackage: { id: `${e.id}-m${i}`, createdAt: e.startAtSec + i * 0.001,
        messageType: f.dir === 'in' ? 'receiveMessage' : 'sendMessage',
        stringValue: f.binary ? null : f.data.toString('utf8'), dataValue: f.binary ? f.data.toString('base64') : null } }));
    return [traffic, ...frames];
  }
  const headers = e.kind === 'sse' ? { 'content-type': 'text/event-stream' } : FAKE_HEADERS(seq);
  return [envelope(e.device, 'traffic', {
    id: e.id, startAt: e.startAtSec, endAt: e.startAtSec + e.durationMs / 1000, packageType: 'http',
    request: { url: e.url, method: e.method, headers: kv(FAKE_HEADERS(seq)), body: b64(e.reqBody) },
    response: { statusCode: e.status, headers: kv(headers) }, responseBodyData: b64(e.resBody), error: null })];
}

// Expansive-gzip Atlantis frame: a valid traffic envelope whose gzip payload is tiny
// but expands to `resSize` bytes of body on decode.
export function atlantisExpansiveFrame(device: string, seq: number, resSize: number): Buffer {
  const env = envelope(device, 'traffic', { id: `${device}-gz-${seq}`, startAt: BASE_SEC + seq * 0.02, endAt: BASE_SEC + seq * 0.02 + 0.1,
    packageType: 'http', request: { url: `https://bench.invalid/v1/gzip?n=${seq}`, method: 'GET', headers: [] },
    response: { statusCode: 200, headers: [{ key: 'content-encoding', value: 'identity' }] },
    responseBodyData: expansiveBody(resSize).toString('base64'), error: null });
  return atlantisFrame(env, true);
}
