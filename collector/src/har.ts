import type { Writable } from 'node:stream';
import type {
  Entry, WsSession, StoredEntry, StoredFrame, ExportSession, ExportSnapshot, BodyRef,
} from './types.js';
import { storedToEntry } from './captureDto.js';
import { VERSION } from './version.js';
import type { BodyStore } from './bodyStore.js';

type Nv = { name: string; value: string };

// The `_terminus` per-body extension: why a body is not carried as recoverable
// bytes, and the ORIGINAL size when it is known. It never fabricates a size or a
// success marker — absence of a body is not an omission and carries no extension.
type TerminusBodyExt = { state: 'omitted' | 'absent'; reason?: BodyRef['omitted']; size?: number };
// One `_webSocketMessages` entry (Chrome DevTools extension): send/receive and a
// time in SECONDS. `opcode` is 1/2 only for a complete captured text/binary
// message; a dropped or absent payload carries `_terminus` instead and no
// fabricated opcode.
type WsMessage = {
  type: 'send' | 'receive'; time: number; opcode?: 1 | 2; data?: string;
  _terminus?: { state?: 'omitted' | 'absent'; reason?: BodyRef['omitted']; size?: number; encoding?: 'base64' };
};
type PostData = { mimeType: string; text?: string; _terminus?: TerminusBodyExt;
  _terminusContent?: { text: string; encoding: 'base64'; size: number } };
type Content = { size: number; mimeType: string; text?: string; encoding?: 'base64'; _terminus?: TerminusBodyExt };

// The `_terminus` session extension carried on a WS/SSE HAR entry: the fields a
// plain HAR entry cannot express — the socket kind, the close frame (or its
// absence), the retained/dropped frame counts and whether the prefix is partial.
type TerminusWsExt = {
  kind: 'websocket' | 'sse'; source: string; wsId: string; deviceId: string; openedAt: number;
  partial?: true; synthetic?: true; statusUnknown?: true;
  retainedFrames: number; totalFrames: number; droppedFrames: number;
  close: { at: number; code: number | null; reason: string } | null;
};

export type HarEntry = {
  startedDateTime: string; time: number;
  request: { method: string; url: string; httpVersion: string; cookies: Nv[]; headers: Nv[]; queryString: Nv[]; postData?: PostData; headersSize: number; bodySize: number };
  response: { status: number; statusText: string; httpVersion: string; cookies: Nv[]; headers: Nv[]; content: Content; redirectURL: string; headersSize: number; bodySize: number };
  cache: Record<string, never>; timings: { send: number; wait: number; receive: number }; comment?: string;
  // terminus extensions (see brief R5): a linked/synthetic socket's messages and
  // metadata. `_webSocketMessages` is a Chrome DevTools convention; SSE uses its
  // own `_terminusEventStream`. Interop of these fields is documented, not assumed.
  _webSocketMessages?: WsMessage[];
  _terminusEventStream?: WsMessage[];
  _terminus?: TerminusWsExt | TerminusWsExt[];
};
export type HarLog = { log: { version: '1.2'; creator: { name: string; version: string }; entries: HarEntry[] } };

const CREATOR = { name: 'terminus', version: VERSION };
const nv = (h: Record<string, string>): Nv[] => Object.entries(h).map(([name, value]) => ({ name, value }));
const mime = (h: Record<string, string>) => Object.entries(h).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? 'application/octet-stream';
function query(url: string): Nv[] { try { return [...new URL(url).searchParams].map(([name, value]) => ({ name, value })); } catch { return []; } }

// ---- Legacy text-DTO HAR (unchanged; still used by the unit test) ---------
export function toHar(entries: Entry[]): HarLog {
  return { log: { version: '1.2', creator: { ...CREATOR }, entries: entries.map((e): HarEntry => ({
    startedDateTime: new Date(e.startedAt).toISOString(), time: e.durationMs ?? -1,
    request: { method: e.method, url: e.url, httpVersion: 'HTTP/1.1', cookies: [], headers: nv(e.requestHeaders), queryString: query(e.url),
      ...(e.requestBody !== null ? { postData: { mimeType: mime(e.requestHeaders), text: e.requestBody } } : {}), headersSize: -1, bodySize: e.requestBodySize },
    response: { status: e.status ?? 0, statusText: e.statusText, httpVersion: 'HTTP/1.1', cookies: [], headers: nv(e.responseHeaders),
      content: { size: e.responseBodySize, mimeType: mime(e.responseHeaders), ...(e.responseBody !== null ? { text: e.responseBody } : {}) }, redirectURL: '', headersSize: -1, bodySize: e.responseBodySize },
    cache: {}, timings: { send: 0, wait: e.durationMs ?? -1, receive: 0 }, ...(e.error ? { comment: `error: ${e.error}` } : {}) })) } };
}

// ---- Body → HAR pieces (one body resolved at a time) ----------------------

const readCaptured = (ref: BodyRef, snap: ExportSnapshot): Uint8Array =>
  (ref.state === 'captured' && ref.sha256 ? snap.readBody(ref.sha256) : undefined) ?? new Uint8Array(0);

// Original byte length for HAR's bodySize: 0 for an absent body, the known size
// for a captured/omitted one, else -1 (unknown) — never a fabricated length.
const bodySize = (ref: BodyRef): number => (ref.state === 'absent' ? 0 : ref.size ?? -1);

const omissionExt = (ref: BodyRef): TerminusBodyExt => ({ state: 'omitted', reason: ref.omitted, ...(ref.size != null ? { size: ref.size } : {}) });

// Response body → HAR `content`. Captured binary rides the standard `content`
// field with `encoding: 'base64'` and the true size; captured text is UTF-8;
// omission records a reason without inventing text; an absent body is size 0 with
// no text and NO extension (absence is not omission); an empty captured body
// keeps an empty `text` so it does not vanish.
function responseContent(ref: BodyRef, headers: Record<string, string>, snap: ExportSnapshot): Content {
  const mimeType = mime(headers);
  if (ref.state === 'absent') return { size: 0, mimeType };
  if (ref.state === 'omitted') return { size: ref.size ?? 0, mimeType, _terminus: omissionExt(ref) };
  const bytes = readCaptured(ref, snap);
  const size = ref.size ?? bytes.length;
  if (ref.encoding === 'binary') return { size, mimeType, text: Buffer.from(bytes).toString('base64'), encoding: 'base64' };
  return { size, mimeType, text: Buffer.from(bytes).toString('utf8') };
}

// Request body → HAR `postData`. A captured binary request does NOT get a fake
// UTF-8 `text`; its bytes go in `_terminusContent` as base64. An absent request
// body yields no postData at all.
function requestPostData(ref: BodyRef, headers: Record<string, string>, snap: ExportSnapshot): PostData | undefined {
  if (ref.state === 'absent') return undefined;
  const mimeType = mime(headers);
  // har-schema 2.0.0 requires postData to carry `text` (or `params`). For an
  // omitted or binary request body we emit an EMPTY `text` (not a fabricated
  // UTF-8 payload) so the entry validates, and the real state rides the marker.
  if (ref.state === 'omitted') return { mimeType, text: '', _terminus: omissionExt(ref) };
  const bytes = readCaptured(ref, snap);
  const size = ref.size ?? bytes.length;
  if (ref.encoding === 'binary') return { mimeType, text: '', _terminusContent: { text: Buffer.from(bytes).toString('base64'), encoding: 'base64', size } };
  return { mimeType, text: Buffer.from(bytes).toString('utf8') };
}

// ---- WS/SSE session → HAR pieces ------------------------------------------

function wsExt(ss: ExportSession, extra?: { synthetic?: true; statusUnknown?: true }): TerminusWsExt {
  return {
    kind: ss.kind, source: ss.source, wsId: ss.wsId, deviceId: ss.deviceId, openedAt: ss.openedAt,
    ...(ss.partial ? { partial: true as const } : {}), ...extra,
    retainedFrames: ss.retainedFrames, totalFrames: ss.totalFrames, droppedFrames: ss.droppedFrames,
    close: ss.closedAt != null ? { at: ss.closedAt, code: ss.closeCode, reason: ss.closeReason } : null,
  };
}

// One captured frame → one `_webSocketMessages`/`_terminusEventStream` entry.
// `withOpcode` is false for SSE (event streams have no WS opcode). A dropped or
// absent payload is recorded via `_terminus`, never guessed as text.
function frameMessage(fr: StoredFrame, snap: ExportSnapshot, withOpcode: boolean): WsMessage {
  const m: WsMessage = { type: fr.direction === 'out' ? 'send' : 'receive', time: fr.ts / 1000 };
  const ref = fr.body;
  if (ref.state === 'captured' && ref.sha256) {
    const bytes = snap.readBody(ref.sha256) ?? new Uint8Array(0);
    if (ref.encoding === 'binary') { if (withOpcode) m.opcode = 2; m.data = Buffer.from(bytes).toString('base64'); m._terminus = { encoding: 'base64' }; }
    else { if (withOpcode) m.opcode = 1; m.data = Buffer.from(bytes).toString('utf8'); }
  } else if (ref.state === 'omitted') {
    m._terminus = omissionExt(ref);
  } else {
    m._terminus = { state: 'absent' };
  }
  return m;
}

const wsMessages = (ss: ExportSession, snap: ExportSnapshot): WsMessage[] => ss.frames.map((fr) => frameMessage(fr, snap, true));
const sseMessages = (ss: ExportSession, snap: ExportSnapshot): WsMessage[] => ss.frames.map((fr) => frameMessage(fr, snap, false));

function attachSessions(har: HarEntry, sessions: ExportSession[], snap: ExportSnapshot): void {
  const ws = sessions.filter((s) => s.kind === 'websocket');
  const sse = sessions.filter((s) => s.kind === 'sse');
  if (ws.length) har._webSocketMessages = ws.flatMap((s) => wsMessages(s, snap));
  if (sse.length) har._terminusEventStream = sse.flatMap((s) => sseMessages(s, snap));
  har._terminus = sessions.map((s) => wsExt(s));
}

// A real HTTP exchange → HAR entry, with any WS/SSE sessions LINKED to it
// (`httpEntryKey`) attached rather than duplicated as separate entries.
function harFromEntry(e: StoredEntry, linked: ExportSession[], snap: ExportSnapshot): HarEntry {
  const postData = requestPostData(e.requestBody, e.requestHeaders, snap);
  const har: HarEntry = {
    startedDateTime: new Date(e.startedAt).toISOString(), time: e.durationMs ?? -1,
    request: { method: e.method, url: e.url, httpVersion: 'HTTP/1.1', cookies: [], headers: nv(e.requestHeaders), queryString: query(e.url),
      ...(postData ? { postData } : {}), headersSize: -1, bodySize: bodySize(e.requestBody) },
    response: { status: e.status ?? 0, statusText: e.statusText, httpVersion: 'HTTP/1.1', cookies: [], headers: nv(e.responseHeaders),
      content: responseContent(e.responseBody, e.responseHeaders, snap), redirectURL: '', headersSize: -1, bodySize: bodySize(e.responseBody) },
    cache: {}, timings: { send: 0, wait: e.durationMs ?? -1, receive: 0 }, ...(e.error ? { comment: `error: ${e.error}` } : {}),
  };
  if (linked.length) attachSessions(har, linked, snap);
  return har;
}

// A WS/SSE session with no linked (selected) HTTP handshake → a synthetic entry,
// explicitly marked, with an UNKNOWN status (0) and unmeasured timings (-1). It
// carries the socket url but is never matched to an existing entry by url.
function harFromSession(ss: ExportSession, snap: ExportSnapshot): HarEntry {
  const isSse = ss.kind === 'sse';
  const har: HarEntry = {
    startedDateTime: new Date(ss.openedAt).toISOString(), time: -1,
    request: { method: 'GET', url: ss.url ?? '', httpVersion: 'HTTP/1.1', cookies: [], headers: [], queryString: query(ss.url ?? ''), headersSize: -1, bodySize: 0 },
    response: { status: 0, statusText: '', httpVersion: 'HTTP/1.1', cookies: [], headers: [],
      content: { size: 0, mimeType: isSse ? 'text/event-stream' : 'application/x-websocket' }, redirectURL: '', headersSize: -1, bodySize: -1 },
    cache: {}, timings: { send: -1, wait: -1, receive: -1 },
    comment: 'terminus: synthetic entry for a captured socket with no linked HTTP handshake',
    _terminus: wsExt(ss, { synthetic: true, statusUnknown: true }),
  };
  if (isSse) har._terminusEventStream = sseMessages(ss, snap);
  else har._webSocketMessages = wsMessages(ss, snap);
  return har;
}

// ---- Streaming writers (backpressure-aware, lease released in finally) -----

const keyStr = (deviceId: string, id: string): string => JSON.stringify([deviceId, id]);

// Write one chunk, awaiting `drain` when the buffer is full so a slow consumer
// applies real backpressure instead of growing an unbounded write queue. Rejects
// on stream error/close so the caller's `finally` releases the lease.
function writeChunk(out: Writable, s: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (out.write(s)) return resolve();
    const cleanup = () => { out.off('drain', onDrain); out.off('error', onErr); out.off('close', onClose); };
    const onDrain = () => { cleanup(); resolve(); };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error('stream closed before drain')); };
    out.once('drain', onDrain); out.once('error', onErr); out.once('close', onClose);
  });
}

function endStream(out: Writable): Promise<void> {
  return new Promise((resolve, reject) => { out.once('error', reject); out.end(() => resolve()); });
}

// Group sessions by the HTTP entry they link to (when that entry is in scope);
// the rest become synthetic entries.
function splitSessions(entries: StoredEntry[], sessions: ExportSession[]): { linked: Map<string, ExportSession[]>; unlinked: ExportSession[] } {
  const inScope = new Set(entries.map((e) => keyStr(e.deviceId, e.id)));
  const linked = new Map<string, ExportSession[]>();
  const unlinked: ExportSession[] = [];
  for (const ss of sessions) {
    const lk = ss.httpEntryKey;
    const lkStr = lk ? keyStr(lk.deviceId, lk.id) : null;
    if (lkStr && inScope.has(lkStr)) { const a = linked.get(lkStr) ?? []; a.push(ss); linked.set(lkStr, a); }
    else unlinked.push(ss);
  }
  return { linked, unlinked };
}

// Stream a HAR 1.2 log to `out`, one entry at a time, resolving each body just
// before it is written and never holding the whole document. The lease is always
// released (finally), including on abort. HTTP entries come first (with linked
// sockets attached), then synthetic entries for unlinked sockets.
export async function writeHar(snap: ExportSnapshot, out: Writable): Promise<void> {
  try {
    const { linked, unlinked } = splitSessions(snap.entries, snap.sessions);
    await writeChunk(out, `{"log":{"version":"1.2","creator":${JSON.stringify(CREATOR)},"entries":[`);
    let first = true;
    const emit = async (har: HarEntry): Promise<void> => {
      await writeChunk(out, (first ? '' : ',') + JSON.stringify(har));
      first = false;
    };
    for (const e of snap.entries) await emit(harFromEntry(e, linked.get(keyStr(e.deviceId, e.id)) ?? [], snap));
    for (const ss of unlinked) await emit(harFromSession(ss, snap));
    await writeChunk(out, ']}}');
    await endStream(out);
  } finally {
    snap.release();
  }
}

// Materialize one StoredEntry → the legacy text `Entry` DTO via a read-only shim
// over the snapshot's bodies (only `read` is exercised).
function entryToLegacy(s: StoredEntry, snap: ExportSnapshot): Entry {
  const shim = { read: (h: string) => snap.readBody(h) } as unknown as BodyStore;
  return storedToEntry(s, shim);
}

function frameToLegacy(fr: StoredFrame, snap: ExportSnapshot): WsSession['frames'][number] {
  let data: string | null = null;
  if (fr.body.state === 'captured' && fr.body.encoding === 'utf8' && fr.body.sha256) {
    const b = snap.readBody(fr.body.sha256); data = b ? Buffer.from(b).toString('utf8') : null;
  }
  return { ts: fr.ts, direction: fr.direction, data, size: fr.size, binary: fr.binary };
}

function sessionToLegacy(ss: ExportSession, snap: ExportSnapshot): WsSession {
  const { frames, retainedFrames: _r, totalFrames: _t, droppedFrames: _d, ...shell } = ss;
  return { ...shell, frames: frames.map((fr) => frameToLegacy(fr, snap)) };
}

// Stream the raw `{ entries, ws }` JSON export under the SAME bounded snapshot
// model as HAR: records are serialized one at a time, so a large store never
// forces a single JSON.stringify of every retained byte at once.
export async function writeJson(snap: ExportSnapshot, out: Writable): Promise<void> {
  try {
    await writeChunk(out, '{"entries":[');
    let first = true;
    for (const e of snap.entries) { await writeChunk(out, (first ? '' : ',') + JSON.stringify(entryToLegacy(e, snap))); first = false; }
    await writeChunk(out, '],"ws":[');
    first = true;
    for (const ss of snap.sessions) { await writeChunk(out, (first ? '' : ',') + JSON.stringify(sessionToLegacy(ss, snap))); first = false; }
    await writeChunk(out, ']}');
    await endStream(out);
  } finally {
    snap.release();
  }
}
