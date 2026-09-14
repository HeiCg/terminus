import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Store } from './store.js';
import type { Entry, EntryInput, Source, BodyOmitted, WsSession } from './types.js';
import type { HarLog, HarEntry } from './har.js';

// T7.3 capture import: read a Terminus JSON export (`{ entries, ws }` from
// /export.json) or a HAR 1.2 log (from /export.har, with the `_terminus*`
// extensions) and insert its records into the store. A synthetic `Device` is
// created for any device the file references that is not already present.
//
// Both exports are lossless for identity. The JSON export carries each entry's
// `source`, `deviceId` and text bodies verbatim. A Terminus HAR carries an HTTP
// entry's `deviceId`/`id`/`source` (and any `replayOf`) on its `_terminus` identity
// extension (T9), so imported entries land exactly where they were captured, with
// bodies (including base64 binary) recovered. A plain third-party HAR has no
// `_terminus`, so its HTTP entries take `deviceId: 'har:<basename>'` and a default
// `source: 'xhr'`.

export type LoadSummary = { entries: number; sessions: number; frames: number };

const KNOWN_SOURCES = new Set<Source>(['xhr', 'atlantis', 'proxy', 'replay']);
const asSource = (s: unknown): Source => (typeof s === 'string' && KNOWN_SOURCES.has(s as Source) ? (s as Source) : 'xhr');

function isUtf8(bytes: Uint8Array): boolean {
  try { new TextDecoder('utf8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}

// Record a synthetic device for an id the store has not seen, so imported traffic
// shows a device row. An id already present is left untouched.
function ensureDevice(store: Store, deviceId: string, lastSeen: number, seen: Set<string>): void {
  if (seen.has(deviceId)) return;
  seen.add(deviceId);
  if (store.devices().some((d) => d.deviceId === deviceId)) return;
  store.touchDevice({ deviceId, platform: 'imported', appVersion: '', buildProfile: 'imported', dropped: 0, lastSeen });
}

// ---- JSON export ({ entries: Entry[], ws: WsSession[] }) -------------------

function loadJsonExport(store: Store, doc: { entries?: unknown; ws?: unknown }, gen: string): LoadSummary {
  const summary: LoadSummary = { entries: 0, sessions: 0, frames: 0 };
  const seen = new Set<string>();
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  for (const e of entries as Entry[]) {
    if (!e || typeof e.id !== 'string' || typeof e.deviceId !== 'string') continue;
    ensureDevice(store, e.deviceId, e.startedAt ?? Date.now(), seen);
    store.addEntry({ ...e, source: asSource(e.source) });
    summary.entries++;
  }
  const sessions = Array.isArray(doc.ws) ? doc.ws : [];
  for (const s of sessions as WsSession[]) {
    if (!s || typeof s.wsId !== 'string' || typeof s.deviceId !== 'string') continue;
    ensureDevice(store, s.deviceId, s.openedAt ?? Date.now(), seen);
    const { frames = [], ...shell } = s;
    store.addWsSession({ ...shell, source: asSource(s.source), generation: gen });
    for (const f of frames) {
      store.appendWsFrame(s.wsId, { ts: f.ts, direction: f.direction, data: f.data, size: f.size, binary: f.binary }, null, s.deviceId, asSource(s.source));
      summary.frames++;
    }
    if (s.closedAt != null) store.closeWs(s.wsId, s.closedAt, s.closeCode ?? 1000, s.closeReason ?? '', s.deviceId);
    summary.sessions++;
  }
  return summary;
}

// ---- HAR 1.2 (+ _terminus extensions) -------------------------------------

const headerObj = (nv: { name: string; value: string }[] | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const { name, value } of nv ?? []) out[name] = value;
  return out;
};

// A HAR request/response body → the bytes + omission the store needs. Handles the
// `_terminus`/`_terminusContent` extensions written by the exporter as well as a
// plain (third-party) `text`/base64 body.
function bodyBytes(
  text: string | undefined,
  encoding: string | undefined,
  ext: { state?: string; reason?: BodyOmitted; size?: number } | undefined,
  content: { text: string; encoding: 'base64'; size: number } | undefined,
): { bytes: Uint8Array | null; omitted: BodyOmitted; size: number } {
  if (content) { const b = Buffer.from(content.text, 'base64'); return { bytes: b, omitted: 'binary', size: content.size }; }
  if (ext && ext.state === 'omitted') return { bytes: null, omitted: (ext.reason ?? 'size') as BodyOmitted, size: ext.size ?? 0 };
  if (text == null || text === '') return { bytes: null, omitted: null, size: 0 };
  if (encoding === 'base64') { const b = Buffer.from(text, 'base64'); return { bytes: b, omitted: 'binary', size: b.length }; }
  const b = Buffer.from(text, 'utf8');
  return { bytes: b, omitted: b.length && !isUtf8(b) ? 'binary' : null, size: b.length };
}

// The `_terminus` identity extension the exporter writes on an HTTP entry (T9). A
// third-party HAR carries none of this; a Terminus HAR carries device/id/source so
// the entry lands exactly where it was captured, with its replay back-reference and
// linked sockets (`sessions`) preserved.
type HttpExt = { deviceId?: string; id?: string; source?: string; ts?: number; replayOf?: Entry['replayOf']; sessions?: WsExt[] };

function harHttpEntry(store: Store, he: HarEntry, http: HttpExt | undefined, fallbackDevice: string, seen: Set<string>): void {
  const startedAt = (http?.ts ?? Date.parse(he.startedDateTime)) || Date.now();
  const deviceId = http?.deviceId ?? fallbackDevice;
  ensureDevice(store, deviceId, startedAt, seen);
  const req = bodyBytes(he.request.postData?.text, undefined, he.request.postData?._terminus, he.request.postData?._terminusContent);
  const resp = bodyBytes(he.response.content?.text, he.response.content?.encoding, he.response.content?._terminus, undefined);
  const input: EntryInput = {
    id: http?.id ?? `har-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    deviceId, source: http?.source != null ? asSource(http.source) : 'xhr', startedAt,
    method: he.request.method, url: he.request.url,
    requestHeaders: headerObj(he.request.headers), requestBytes: req.bytes, requestBodySize: req.size, requestBodyOmitted: req.omitted,
    status: he.response.status || null, statusText: he.response.statusText ?? '',
    responseHeaders: headerObj(he.response.headers), responseBytes: resp.bytes, responseBodySize: resp.size, responseBodyOmitted: resp.omitted,
    durationMs: he.time >= 0 ? he.time : null,
    error: he.comment?.startsWith('error: ') ? he.comment.slice('error: '.length) : null,
    ...(http?.replayOf ? { replayOf: http.replayOf } : {}),
  };
  store.addEntryInput(input);
}

type WsExt = { kind: 'websocket' | 'sse'; source?: string; wsId?: string; deviceId?: string; openedAt?: number;
  close?: { at: number; code: number | null; reason: string } | null };
type WsMsg = { type: 'send' | 'receive'; time: number; opcode?: number; data?: string;
  _terminus?: { state?: string; reason?: BodyOmitted; size?: number; encoding?: string } };

// Reconstruct one captured socket from its `_terminus` extension and its message
// array (`_webSocketMessages` for a websocket, `_terminusEventStream` for SSE).
function harSocket(store: Store, ext: WsExt, url: string | null, messages: WsMsg[], gen: string, seen: Set<string>, summary: LoadSummary): void {
  const deviceId = ext.deviceId ?? 'har';
  const wsId = ext.wsId ?? `har-${ext.openedAt ?? 0}`;
  const openedAt = ext.openedAt ?? 0;
  ensureDevice(store, deviceId, openedAt, seen);
  store.addWsSession({
    wsId, deviceId, source: asSource(ext.source), url, openedAt, kind: ext.kind, httpEntryKey: null,
    closedAt: ext.close?.at ?? null, closeCode: ext.close?.code ?? null, closeReason: ext.close?.reason ?? '', generation: gen,
  });
  for (const m of messages) {
    const direction = m.type === 'send' ? 'out' : 'in';
    const ts = Math.round(m.time * 1000);
    const binary = m._terminus?.encoding === 'base64' || m.opcode === 2;
    if (m.data != null && binary) {
      const bytes = Buffer.from(m.data, 'base64');
      store.appendWsFrame(wsId, { ts, direction, data: null, size: bytes.length, binary: true }, bytes, deviceId, asSource(ext.source));
    } else if (m.data != null) {
      store.appendWsFrame(wsId, { ts, direction, data: m.data, size: Buffer.byteLength(m.data, 'utf8'), binary: false }, null, deviceId, asSource(ext.source));
    } else {
      store.appendWsFrame(wsId, { ts, direction, data: null, size: m._terminus?.size ?? 0, binary: false }, null, deviceId, asSource(ext.source));
    }
    summary.frames++;
  }
  if (ext.close) store.closeWs(wsId, ext.close.at, ext.close.code ?? 1000, ext.close.reason, deviceId);
  summary.sessions++;
}

function loadHar(store: Store, doc: HarLog, basename: string, gen: string): LoadSummary {
  const summary: LoadSummary = { entries: 0, sessions: 0, frames: 0 };
  const seen = new Set<string>();
  const httpDevice = `har:${basename}`;
  for (const he of doc.log.entries ?? []) {
    const t = he._terminus;
    const wsMsgs = (he._webSocketMessages ?? []) as WsMsg[];
    const sseMsgs = (he._terminusEventStream ?? []) as WsMsg[];
    // A socket-only entry: a WS/SSE ext (it has `kind`) with no HTTP exchange in
    // scope at export time. The HTTP identity ext (T9) never has `kind`.
    if (t != null && !Array.isArray(t) && 'kind' in t) {
      const ext = t as unknown as WsExt;
      harSocket(store, ext, he.request.url || null, ext.kind === 'sse' ? sseMsgs : wsMsgs, gen, seen, summary);
      continue;
    }
    // A real HTTP entry. Its identity rides `_terminus` (T9) when the file is a
    // Terminus export; a third-party HAR has none, so it falls back to the
    // `har:<basename>` device and `source: xhr`.
    const http = (t != null && !Array.isArray(t)) ? (t as unknown as HttpExt) : undefined;
    harHttpEntry(store, he, http, httpDevice, seen);
    summary.entries++;
    // Linked sockets: the T9 shape nests them under `_terminus.sessions`; a legacy
    // export carried them as the bare `_terminus` array.
    const linked: WsExt[] = http?.sessions ?? (Array.isArray(t) ? (t as unknown as WsExt[]) : []);
    for (const ext of linked) {
      harSocket(store, ext, he.request.url || null, ext.kind === 'sse' ? sseMsgs : wsMsgs, gen, seen, summary);
    }
  }
  return summary;
}

// ---- Entry points ---------------------------------------------------------

function isHar(doc: unknown): doc is HarLog {
  const d = doc as { log?: { entries?: unknown; version?: unknown } };
  return !!d && typeof d === 'object' && !!d.log && Array.isArray(d.log.entries);
}
function isJsonExport(doc: unknown): doc is { entries: unknown[]; ws?: unknown[] } {
  const d = doc as { entries?: unknown };
  return !!d && typeof d === 'object' && Array.isArray(d.entries);
}

// Parse an already-decoded document (JSON export or HAR) into the store. `basename`
// names the synthetic device used for HAR HTTP entries.
export function loadCaptureDoc(store: Store, doc: unknown, basename: string): LoadSummary {
  const gen = `load:${basename}`;
  if (isHar(doc)) return loadHar(store, doc, basename, gen);
  if (isJsonExport(doc)) return loadJsonExport(store, doc as { entries: unknown[]; ws?: unknown[] }, gen);
  throw new Error(`unrecognized capture format (expected a Terminus HAR 1.2 or JSON export)`);
}

// Read and import one file. Throws with the file path on a read/parse/format error.
export function loadCaptureFile(store: Store, filePath: string): LoadSummary {
  let raw: string;
  try { raw = readFileSync(filePath, 'utf8'); } catch (e) { throw new Error(`--load ${filePath}: cannot read (${e instanceof Error ? e.message : e})`); }
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { throw new Error(`--load ${filePath}: not valid JSON`); }
  try { return loadCaptureDoc(store, doc, path.basename(filePath)); }
  catch (e) { throw new Error(`--load ${filePath}: ${e instanceof Error ? e.message : e}`); }
}
