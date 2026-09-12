import { gunzipSync, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { EntryInput, BodyOmitted } from '../types.js';
import { redactHeaders, redactUrl, redactText } from '../redactor.js';
const gunzipAsync = promisify(gunzip);
const MAX_GUNZIP = 64 * 1024 * 1024;

// Decompressed-size ceilings applied before any JSON/base64 work. Pre-auth traffic
// is held to 64 KiB; an authenticated v2 device may send up to an 8 MiB envelope
// with a 4 MiB inner `content` JSON and 1 MiB per captured body. Oversize is
// rejected before it is expanded/converted.
export type DecodeLimits = { maxEnvelope: number; maxInnerJson: number; maxBody: number };
export const PER_BODY_MAX = 1 * 1024 * 1024; // spec: 1 MiB per HTTP body
export const WS_MESSAGE_MAX = 256 * 1024;    // spec: 256 KiB per WebSocket message
export const V2_LIMITS: DecodeLimits = { maxEnvelope: 8 * 1024 * 1024, maxInnerJson: 4 * 1024 * 1024, maxBody: PER_BODY_MAX };
export const PREAUTH_LIMITS: DecodeLimits = { maxEnvelope: 64 * 1024, maxInnerJson: 64 * 1024, maxBody: 64 * 1024 };
export const LEGACY_LIMITS: DecodeLimits = { maxEnvelope: MAX_GUNZIP, maxInnerJson: MAX_GUNZIP, maxBody: MAX_GUNZIP };
type Kv = { key: string; value: string };
type WsMsg = { id: string; createdAt: number; messageType: string; stringValue?: string | null; dataValue?: string | null };
type Traffic = { id: string; startAt: number; endAt?: number | null; packageType?: string;
  request: { url: string; method: string; headers?: Kv[]; body?: string | null };
  response?: { statusCode: number; headers?: Kv[] } | null; responseBodyData?: string | null;
  error?: { code: number; message: string } | null; websocketMessagePackage?: WsMsg | null };
// A decoded WebSocket frame: text frames carry redacted `text`; binary frames
// carry their raw `bytes` (decoded once from `dataValue`, never discarded after
// measuring). `size` is the real byte length.
export type WsFrameDecoded = { id: string; createdAt: number; messageType: string; text: string | null; bytes: Uint8Array | null; size: number; binary: boolean };
export type AtlantisEvent =
  | { kind: 'connection'; deviceKey: string; buildVersion: string | null; appVersion: string | null; passcode: string | null; device: { name: string; model: string }; project: { name: string; bundleIdentifier: string } }
  | { kind: 'traffic'; deviceKey: string; isWebsocket: boolean; isSse: boolean; entry: EntryInput }
  | { kind: 'ws'; deviceKey: string; trafficId: string; url: string; msg: WsFrameDecoded }
  // A control frame from the client (e.g. a `pong` replying to a server ping). The
  // type is not inspected: any control message decodes to this no-op event so it is
  // accepted and ignored rather than counted as an undecodable/invalid frame.
  | { kind: 'control'; deviceKey: string };
const isGzip = (b: Buffer) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
// Preserve repeated headers (e.g. multiple Set-Cookie) by joining with a newline
// instead of letting later keys overwrite earlier ones.
function headers(h?: Kv[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of h ?? []) out[key] = key in out ? `${out[key]}\n${value}` : value;
  return out;
}
// Sentinels the Atlantis forks emit when they skip a large body: iOS uses
// '<Skip Large Body>', the Android fork '<Body too large>'. Compared as bytes so
// no text is materialized for the check.
const LARGE_BODY = ['<Skip Large Body>', '<Body too large>'].map((s) => Buffer.from(s, 'utf8'));
const isSentinel = (buf: Buffer): boolean => LARGE_BODY.some((s) => s.equals(buf));

// A strict UTF-8 validator over bytes: throws on invalid sequences without
// re-encoding. Used to classify binary vs text without a round-trip through a
// re-encoded string (O05).
const strictUtf8 = new TextDecoder('utf8', { fatal: true });

type DecodedBody = { bytes: Uint8Array | null; size: number; omitted: BodyOmitted };

// Decode one base64 body EXACTLY once, classify it, and (for text) redact before
// it is handed on to be hashed and stored. Oversize is rejected before any text
// materialization; binary bytes are preserved (encoding marked via `omitted:
// 'binary'` with bytes present); a fork's skip sentinel maps to `omitted: 'size'`.
function decodeBody(s: string | null | undefined, maxBody: number): DecodedBody {
  if (s == null) return { bytes: null, size: 0, omitted: null }; // absent
  const buf = Buffer.from(s, 'base64');
  // Reject an oversized body before converting/materializing anything.
  if (buf.length > maxBody) return { bytes: null, size: buf.length, omitted: 'size' };
  if (isSentinel(buf)) return { bytes: null, size: 0, omitted: 'size' };
  // Classify over the bytes: a NUL byte or invalid UTF-8 is binary. Binary bytes
  // are preserved verbatim; only text is materialized (once) to be redacted.
  let text: string | null = null;
  if (!buf.includes(0)) { try { text = strictUtf8.decode(buf); } catch { text = null; } }
  if (text == null) return { bytes: new Uint8Array(buf), size: buf.length, omitted: 'binary' };
  const redacted = redactText(text) ?? text;
  const redBytes = Buffer.from(redacted, 'utf8');
  return { bytes: new Uint8Array(redBytes), size: redBytes.length, omitted: null };
}

// Content-Type of a traffic package's response, for SSE detection.
function contentType(h?: Kv[]): string {
  for (const { key, value } of h ?? []) if (key.toLowerCase() === 'content-type') return value.toLowerCase();
  return '';
}

function toEntryInput(t: Traffic, deviceKey: string, maxBody: number): EntryInput {
  const req = decodeBody(t.request.body, maxBody);
  const res = decodeBody(t.responseBodyData, maxBody);
  return {
    id: t.id, deviceId: deviceKey, source: 'atlantis', startedAt: Math.round(t.startAt * 1000),
    method: t.request.method, url: redactUrl(t.request.url), requestHeaders: redactHeaders(headers(t.request.headers)),
    requestBytes: req.bytes, requestBodySize: req.size, requestBodyOmitted: req.omitted,
    status: t.response?.statusCode ?? null, statusText: '', responseHeaders: redactHeaders(headers(t.response?.headers)),
    responseBytes: res.bytes, responseBodySize: res.size, responseBodyOmitted: res.omitted,
    durationMs: t.endAt ? Math.round((t.endAt - t.startAt) * 1000) : null,
    error: t.error ? `${t.error.code} ${t.error.message}` : null,
  };
}

// Parse an already-decompressed envelope, enforcing the inner-content ceiling
// before the base64/JSON expansion.
function parseEnvelope(raw: Buffer, limits: DecodeLimits): AtlantisEvent | null {
  const env = JSON.parse(raw.toString('utf8')) as { id: string; messageType: string; content: string; buildVersion?: string | null };
  if (typeof env.content !== 'string') return null;
  const contentBuf = Buffer.from(env.content, 'base64');
  if (contentBuf.length > limits.maxInnerJson) throw new Error(`atlantis inner content too large: ${contentBuf.length}`);
  const inner = JSON.parse(contentBuf.toString('utf8'));
  if (env.messageType === 'connection') return { kind: 'connection', deviceKey: env.id, buildVersion: env.buildVersion ?? null,
    appVersion: inner.appVersion ?? null, passcode: typeof inner.passcode === 'string' ? inner.passcode : null, device: inner.device, project: inner.project };
  if (env.messageType === 'websocket') {
    // inner is a full TrafficPackage snapshot carrying one websocketMessagePackage.
    const t = inner as Traffic;
    const m = t.websocketMessagePackage;
    if (!m) return null;
    // Decode the frame payload exactly once: binary frames preserve bytes,
    // text frames are redacted.
    const hasData = m.dataValue != null;
    let text: string | null = null; let bytes: Uint8Array | null = null; let size = 0; let binary = false;
    if (hasData) {
      const buf = Buffer.from(m.dataValue as string, 'base64');
      binary = true; size = buf.length;
      // Reject an oversized WS message before retaining its bytes (256 KiB cap);
      // the frame's metadata (size/direction) is still recorded.
      bytes = buf.length > WS_MESSAGE_MAX ? null : new Uint8Array(buf);
    } else if (m.stringValue != null) {
      text = redactText(m.stringValue);
      size = Buffer.byteLength(text ?? '', 'utf8');
    }
    return { kind: 'ws', deviceKey: env.id, trafficId: t.id, url: redactUrl(t.request?.url ?? ''),
      msg: { id: m.id, createdAt: m.createdAt, messageType: m.messageType, text, bytes, size, binary } };
  }
  // A control frame (server sends `ready`/`auth_error`/`ping`; the client may reply
  // `pong`). Unknown control types are a no-op: accepted and ignored.
  if (env.messageType === 'control') return { kind: 'control', deviceKey: env.id };
  if (env.messageType !== 'traffic') return null;
  const t = inner as Traffic;
  const isWebsocket = t.packageType === 'websocket';
  // SSE is detected by response Content-Type on an HTTP exchange, not by a
  // generic package name; it is tunnelled over the same session machinery.
  const isSse = !isWebsocket && contentType(t.response?.headers).startsWith('text/event-stream');
  return { kind: 'traffic', deviceKey: env.id, isWebsocket, isSse, entry: toEntryInput(t, env.id, limits.maxBody) };
}

// Synchronous decode (legacy loopback + unit tests). Uses the historical 64 MiB
// gunzip ceiling by default.
export function decodeAtlantis(payload: Buffer, limits: DecodeLimits = LEGACY_LIMITS): AtlantisEvent | null {
  try {
    const raw = isGzip(payload) ? gunzipSync(payload, { maxOutputLength: limits.maxEnvelope }) : payload;
    if (raw.length > limits.maxEnvelope) return null;
    return parseEnvelope(raw, limits);
  } catch { return null; }
}

// Async decode used by the v2 ingest scheduler: gunzip runs on the libuv threadpool
// so a large payload does not block the event loop. Oversize is rejected before and
// after decompression.
export async function decodeAtlantisAsync(payload: Buffer, limits: DecodeLimits): Promise<AtlantisEvent | null> {
  try {
    let raw: Buffer;
    if (isGzip(payload)) {
      raw = (await gunzipAsync(payload, { maxOutputLength: limits.maxEnvelope })) as Buffer;
    } else {
      if (payload.length > limits.maxEnvelope) return null;
      raw = payload;
    }
    if (raw.length > limits.maxEnvelope) return null;
    return parseEnvelope(raw, limits);
  } catch { return null; }
}
