import type { Entry } from './types.js';
import { isSensitiveName } from './security/sensitiveNames.js';

// Ingest-time redaction (P5). Which names are credentials is decided by the shared
// matcher in security/sensitiveNames.ts; this module only applies it to headers,
// URL query parameters and text bodies. Every pass takes an optional `mark` sink
// that is set when a value was actually masked, which the ingest paths turn into
// the per-side `redacted` marker on the entry.
export const MASK = '***';
export type RedactMark = { hit: boolean };

export function redactHeaders(h: Record<string, string>, mark?: RedactMark): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (!isSensitiveName(k, 'header')) { out[k] = v; continue; }
    if (mark && v !== MASK) mark.hit = true;
    out[k] = MASK;
  }
  return out;
}

export function redactUrl(url: string, mark?: RedactMark): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  let changed = false;
  for (const k of [...u.searchParams.keys()]) {
    if (!isSensitiveName(k, 'query')) continue;
    if (mark && u.searchParams.getAll(k).some((v) => v !== MASK)) mark.hit = true;
    u.searchParams.set(k, MASK); changed = true;
  }
  return changed ? u.toString() : url;
}

// Content-Type of a header record (case-insensitive name), for picking the body pass.
export function contentTypeOf(h: Record<string, string>): string | null {
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === 'content-type') return v;
  return null;
}

// Best-effort pass over any text body: masks the quoted value of a sensitive key
// written as `key: "v"`, `"key":"v"` or `key='v'` (e.g. an ActionCable subscribe
// frame carrying access_token / uid). Escaped quotes (\") are handled so that a JSON
// string nested inside another JSON string is still covered. The key is captured
// whole and judged by the shared matcher (the pre-P5 regex, unanchored on the left,
// is reproduced by the matcher's legacy suffix rule: `guid`, `ns:client`). The key
// only starts at a token boundary and is captured atomically (lookahead + backref),
// so a long run of key characters costs linear time, not quadratic backtracking.
const TEXT_KEY = /(\\?["']?)(?<![A-Za-z0-9_.-])(?=([A-Za-z0-9_.-]+))\2(\\?["']?\s*[:=]\s*\\?["'])([^"'\\]*)/g;
function redactByRegex(s: string, mark?: RedactMark): string {
  return s.replace(TEXT_KEY, (m, pre: string, key: string, mid: string, val: string) => {
    if (!isSensitiveName(key, 'body')) return m;
    if (mark && val !== MASK) mark.hit = true;
    return `${pre}${key}${mid}${MASK}`;
  });
}

// `application/x-www-form-urlencoded`: mask each parameter whose (decoded) name is
// sensitive as a body key or a query parameter; every other byte is kept verbatim.
function redactForm(s: string, mark?: RedactMark): string {
  return s.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    const raw = pair.slice(0, eq);
    let name = raw;
    try { name = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { /* malformed escape: judge the raw name */ }
    if (!isSensitiveName(name, 'body') && !isSensitiveName(name, 'query')) return pair;
    if (mark && pair.slice(eq + 1) !== MASK) mark.hit = true;
    return `${raw}=${MASK}`;
  }).join('&');
}

// Structured JSON pass: a single linear scan that validates the document and
// records the source span of every value whose key is sensitive (at any depth,
// objects inside arrays included). Only those spans are rewritten to "***", so
// the rest of the text (formatting, large numbers) is preserved byte for byte.
// Returns null when the text is not one valid JSON value (truncated, invalid, or
// nested deeper than JSON_MAX_DEPTH), and the caller falls back to the regex pass.
const JSON_MAX_DEPTH = 256;
const JSON_STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_WS = /[ \t\n\r]*/y;
const QUOTED_MASK = `"${MASK}"`;

class JsonInvalid extends Error {}

function redactJson(s: string, mark?: RedactMark): string | null {
  const spans: [number, number][] = [];
  let pos = 0;
  const fail = (): never => { throw new JsonInvalid(); };
  const ws = () => { JSON_WS.lastIndex = pos; JSON_WS.exec(s); pos = JSON_WS.lastIndex; };
  const sticky = (re: RegExp): string => {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) fail();
    pos = re.lastIndex;
    return m![0];
  };
  const value = (depth: number, masked: boolean): void => {
    if (depth > JSON_MAX_DEPTH) fail();
    ws();
    const c = s[pos];
    if (c === '{') {
      pos++; ws();
      if (s[pos] === '}') { pos++; return; }
      for (;;) {
        ws();
        if (s[pos] !== '"') fail();
        const rawKey = sticky(JSON_STRING);
        ws();
        if (s[pos] !== ':') fail();
        pos++; ws();
        const key = rawKey.includes('\\') ? JSON.parse(rawKey) as string : rawKey.slice(1, -1);
        const start = pos;
        const hide = !masked && isSensitiveName(key, 'body');
        value(depth + 1, masked || hide);
        if (hide) spans.push([start, pos]);
        ws();
        if (s[pos] === ',') { pos++; continue; }
        if (s[pos] === '}') { pos++; return; }
        fail();
      }
    }
    if (c === '[') {
      pos++; ws();
      if (s[pos] === ']') { pos++; return; }
      for (;;) {
        value(depth + 1, masked); ws();
        if (s[pos] === ',') { pos++; continue; }
        if (s[pos] === ']') { pos++; return; }
        fail();
      }
    }
    if (c === '"') { sticky(JSON_STRING); return; }
    for (const lit of ['true', 'false', 'null']) if (s.startsWith(lit, pos)) { pos += lit.length; return; }
    sticky(JSON_NUMBER);
  };
  try {
    value(0, false); ws();
    if (pos !== s.length) return null;
  } catch (e) {
    if (e instanceof JsonInvalid) return null;
    throw e;
  }
  if (spans.length === 0) return s;
  let out = ''; let at = 0;
  for (const [from, to] of spans.sort((a, b) => a[0] - b[0])) {
    if (mark && s.slice(from, to) !== QUOTED_MASK) mark.hit = true;
    out += s.slice(at, from) + QUOTED_MASK; at = to;
  }
  return out + s.slice(at);
}

const looksJson = (s: string): boolean => /^\s*[[{]/.test(s);

// Redact one text body (or WebSocket text frame) before it is hashed and stored.
// JSON (by Content-Type, or sniffed from a leading `{`/`[`) is walked by key, a
// form body is masked by parameter name, and every body then gets the best-effort
// regex pass (which also reaches a JSON document embedded in a JSON string). The
// callers already cap the body size (1 MiB per HTTP body, 256 KiB per frame) before
// this runs; nothing here throws on malformed input.
export function redactText(s: string | null, contentType?: string | null, mark?: RedactMark): string | null {
  if (s == null) return s;
  const ct = (contentType ?? '').toLowerCase();
  let out = s;
  if (ct.includes('application/x-www-form-urlencoded')) out = redactForm(s, mark);
  else if (ct.includes('json') || looksJson(s)) out = redactJson(s, mark) ?? s;
  return redactByRegex(out, mark);
}

// The per-side marker for an entry from its two sinks; absent when nothing on
// either side was masked, so an unredacted record keeps its pre-P5 shape.
export function redactionMarker(request: RedactMark, response: RedactMark): Pick<Entry, 'redacted'> {
  return request.hit || response.hit ? { redacted: { request: request.hit, response: response.hit } } : {};
}

// OR two markers (an upsert/patch never loses an earlier `true`); undefined when
// both sides end up false.
export function mergeRedacted(a: Entry['redacted'], b: Entry['redacted']): Entry['redacted'] {
  const request = a?.request === true || b?.request === true;
  const response = a?.response === true || b?.response === true;
  return request || response ? { request, response } : undefined;
}

export function redactEntry(e: Entry): Entry {
  return { ...e, url: redactUrl(e.url), requestHeaders: redactHeaders(e.requestHeaders), responseHeaders: redactHeaders(e.responseHeaders) };
}
