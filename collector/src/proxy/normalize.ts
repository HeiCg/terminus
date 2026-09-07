// Proxy-source normalization (R4/T11). Pure, dependency-light functions that turn
// a mockttp event (an HTTP exchange, a WebSocket frame or a TLS handshake failure)
// into the SAME store-admission shapes the Atlantis decoder produces — with the
// SAME redaction and the SAME per-body/per-message caps applied BEFORE the bytes
// reach the store. Nothing here talks to mockttp or the network, so every branch
// (text/binary/oversize/absent, redaction, direction) is unit-testable with plain
// buffers. The server module (./server.ts) owns the proxy lifecycle and the
// session/client id namespacing; it feeds decoded buffers in and pushes the
// results into the store.
import type { EntryInput, BodyOmitted } from '../types.js';
import { redactHeaders, redactUrl, redactText } from '../redactor.js';

// Same ceilings the Atlantis path enforces (see atlantis/decode.ts): 1 MiB per
// HTTP body, 256 KiB per WebSocket message. A proxy body/frame is held to the
// identical budget so the proxy source never smuggles bytes past the caps the
// other sources respect.
export const PROXY_PER_BODY_MAX = 1 * 1024 * 1024;
export const PROXY_WS_MESSAGE_MAX = 256 * 1024;

// The composite identity the server assigns to one proxied exchange: a namespaced
// entry/ws id (`proxy:<sessionUUID>:<requestUUID>`) and a namespaced device id
// (`proxy:<sessionUUID>:<clientId>`). The proxy invents its OWN session/client
// identity — it never guesses a real device or appVersion from an IP.
export type ProxyIds = { id: string; deviceId: string };

// A strict UTF-8 validator over bytes: throws on an invalid sequence without
// re-encoding, so binary vs text is classified without a round-trip (mirrors the
// Atlantis decoder's O05 classification).
const strictUtf8 = new TextDecoder('utf8', { fatal: true });

export type DecodedBody = { bytes: Uint8Array | null; size: number; omitted: BodyOmitted };

// Classify one already-decoded body buffer and, for text, redact it BEFORE it is
// handed on to be hashed and stored. Oversize is rejected before any text is
// materialized (`omitted: 'size'`); binary bytes are preserved verbatim
// (`omitted: 'binary'`, bytes present); text is redacted and re-encoded.
export function classifyBody(buf: Uint8Array | null | undefined, maxBody = PROXY_PER_BODY_MAX): DecodedBody {
  if (buf == null) return { bytes: null, size: 0, omitted: null }; // absent
  if (buf.length > maxBody) return { bytes: null, size: buf.length, omitted: 'size' };
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let text: string | null = null;
  if (!b.includes(0)) { try { text = strictUtf8.decode(b); } catch { text = null; } }
  if (text == null) return { bytes: new Uint8Array(b), size: b.length, omitted: 'binary' };
  const redacted = redactText(text) ?? text;
  const redBytes = Buffer.from(redacted, 'utf8');
  return { bytes: new Uint8Array(redBytes), size: redBytes.length, omitted: null };
}

// Flatten mockttp headers (values may be arrays, and HTTP/2 pseudo-headers like
// `:method` appear) into the store's `Record<string,string>`, joining repeats with
// a newline (as the Atlantis decoder does for multiple Set-Cookie) and dropping
// pseudo-headers. Redaction is applied by the caller via redactHeaders.
export function normalizeHeaders(h: Record<string, undefined | string | string[]> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    if (v == null || k.startsWith(':')) continue;
    const joined = Array.isArray(v) ? v.join('\n') : v;
    out[k] = k in out ? `${out[k]}\n${joined}` : joined;
  }
  return out;
}

export type EntryParams = {
  ids: ProxyIds; startedAt: number;
  method: string; url: string;
  requestHeaders?: Record<string, undefined | string | string[]>;
  requestBuf?: Uint8Array | null;
  status?: number | null; statusText?: string;
  responseHeaders?: Record<string, undefined | string | string[]>;
  responseBuf?: Uint8Array | null;
  durationMs?: number | null;
  error?: string | null;
  maxBody?: number;
};

// Build one store `EntryInput` for a proxied HTTP exchange. `responseBuf`/`status`
// absent yields a request-only record (the exchange is still in flight, aborted,
// or a TLS failure); passing them yields the merged record. URL, headers and text
// bodies are redacted here — redaction happens before the bytes are stored/hashed.
export function buildEntryInput(p: EntryParams): EntryInput {
  const maxBody = p.maxBody ?? PROXY_PER_BODY_MAX;
  const req = classifyBody(p.requestBuf, maxBody);
  const res = classifyBody(p.responseBuf, maxBody);
  return {
    id: p.ids.id, deviceId: p.ids.deviceId, source: 'proxy', startedAt: p.startedAt,
    method: p.method, url: redactUrl(p.url), requestHeaders: redactHeaders(normalizeHeaders(p.requestHeaders)),
    requestBytes: req.bytes, requestBodySize: req.size, requestBodyOmitted: req.omitted,
    status: p.status ?? null, statusText: p.statusText ?? '', responseHeaders: redactHeaders(normalizeHeaders(p.responseHeaders)),
    responseBytes: res.bytes, responseBodySize: res.size, responseBodyOmitted: res.omitted,
    durationMs: p.durationMs ?? null,
    error: p.error ?? null,
  };
}

// A normalized WebSocket frame ready for store.appendWsFrame. Direction follows the
// Atlantis convention (`in` = from the server, `out` = from the app): mockttp's
// `received` means received FROM the app (app -> server = `out`), `sent` means sent
// BY the proxy to the app (server -> app = `in`). Binary payloads keep their bytes
// (unless over the 256 KiB cap, when the metadata is kept but the bytes dropped);
// text payloads are redacted.
export type NormalizedFrame = {
  frame: { ts: number; direction: 'in' | 'out'; data: string | null; size: number; binary: boolean };
  bytes: Uint8Array | null;
};

export function normalizeWsFrame(
  content: Uint8Array, isBinary: boolean, direction: 'sent' | 'received', ts: number, maxMsg = PROXY_WS_MESSAGE_MAX,
): NormalizedFrame {
  const dir: 'in' | 'out' = direction === 'received' ? 'out' : 'in';
  const size = content.length;
  if (isBinary) {
    // Over-cap binary frame: record the frame metadata, drop the bytes.
    const bytes = size > maxMsg ? null : new Uint8Array(content);
    return { frame: { ts, direction: dir, data: null, size, binary: true }, bytes };
  }
  // Text frame: redact, then re-encode. An over-cap text frame keeps its metadata
  // with no retained text.
  if (size > maxMsg) return { frame: { ts, direction: dir, data: null, size, binary: false }, bytes: null };
  const text = redactText(Buffer.from(content).toString('utf8')) ?? '';
  const redBytes = Buffer.from(text, 'utf8');
  return { frame: { ts, direction: dir, data: text, size: redBytes.length, binary: false }, bytes: new Uint8Array(redBytes) };
}

// Convert a mockttp monotonic `eventTimestamp` into an epoch-ms timestamp using the
// connection's timing anchors (`startTime` is epoch ms, `startTimestamp` the matching
// monotonic reading). Falls back to `startTime` when the deltas are unavailable.
export function epochOf(timing: { startTime: number; startTimestamp?: number }, eventTimestamp?: number): number {
  if (eventTimestamp != null && timing.startTimestamp != null) {
    return Math.round(timing.startTime + (eventTimestamp - timing.startTimestamp));
  }
  return Math.round(timing.startTime);
}
