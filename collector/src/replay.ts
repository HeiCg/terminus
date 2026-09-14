import { randomBytes } from 'node:crypto';
import type { Store } from './store.js';
import type { EntryInput } from './types.js';

// T7.1 request replay. The collector re-sends a captured request to its original
// host from the operator's Mac and stores the result as a NEW entry
// (`source: 'replay'`, a fresh id, a `replayOf` back-reference), never overwriting
// the original. See docs/security.md: a replay leaves the machine.
//
// T8.1: by default the captured credentials are NOT re-sent. The `credentials`
// field (default `'strip'`) removes auth headers and credential-bearing query
// params before the request leaves; `'keep'` restores the old verbatim behaviour.
// Headers the caller supplies explicitly via `overrides.headers` are never stripped
// (the caller chose them). The names removed are reported back so the operator sees
// what was dropped.

export type ReplayCredentials = 'strip' | 'keep';
export type ReplayOverrides = { method?: string; url?: string; headers?: Record<string, string>; body?: string };
export type ReplayRequest = { deviceId: string; id: string; credentials?: ReplayCredentials; overrides?: ReplayOverrides };

export type ReplayResult =
  | { ok: true; key: { deviceId: string; id: string }; status: number | null; durationMs: number; error: string | null; stripped: string[] }
  | { ok: false; code: 400 | 404 | 422; message: string };

// Single source of truth for what counts as a credential when stripping (T8.1).
// Header names: an exact match, or any `x-*` header naming a token/secret/key/auth.
const SENSITIVE_HEADER_NAMES = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token']);
const SENSITIVE_HEADER_PATTERN = /^x-.*(token|secret|key|auth)/i;
// Query param names: an exact match against the common credential spellings, or
// the same `x-*` pattern (a token can travel in either place).
const SENSITIVE_QUERY_NAMES = new Set(['token', 'access_token', 'api_key', 'apikey', 'key', 'auth', 'signature', 'sig']);

function isSensitiveHeaderName(name: string): boolean {
  const n = name.toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(n) || SENSITIVE_HEADER_PATTERN.test(n);
}
function isSensitiveQueryName(name: string): boolean {
  const n = name.toLowerCase();
  return SENSITIVE_QUERY_NAMES.has(n) || SENSITIVE_HEADER_PATTERN.test(n);
}

// Remove credential-bearing headers and query params, returning the cleaned
// headers/url and the names removed (`?name` marks a stripped query param). Header
// names present in `protectedNames` (the caller's explicit overrides) are left
// alone. Pure and exported for direct unit testing.
export function stripCredentials(
  headers: Record<string, string>,
  url: string,
  protectedNames: Set<string>,
): { headers: Record<string, string>; url: string; stripped: string[] } {
  const stripped: string[] = [];
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (isSensitiveHeaderName(k) && !protectedNames.has(k.toLowerCase())) { stripped.push(k.toLowerCase()); continue; }
    outHeaders[k] = v;
  }
  let outUrl = url;
  try {
    const u = new URL(url);
    let changed = false;
    for (const name of [...u.searchParams.keys()]) {
      if (isSensitiveQueryName(name)) { u.searchParams.delete(name); stripped.push(`?${name.toLowerCase()}`); changed = true; }
    }
    if (changed) outUrl = u.toString();
  } catch { /* non-absolute or malformed URL: nothing to strip from */ }
  return { headers: outHeaders, url: outUrl, stripped };
}

// Hop-by-hop headers (RFC 7230 §6.1) plus `host`/`content-length`, which the
// outgoing fetch recomputes for the new request. This always runs; credential
// stripping (T8.1) is a separate, default-on pass applied before this one.
const STRIP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

// Methods that never carry a request body; fetch throws if one is attached.
const BODYLESS = new Set(['GET', 'HEAD']);

const REPLAY_TIMEOUT_MS = 30_000;

function stripHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (!STRIP_HEADERS.has(k.toLowerCase())) out[k] = v;
  return out;
}

function isUtf8(bytes: Uint8Array): boolean {
  try { new TextDecoder('utf8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}

// Collect a fetch Response's headers into a plain object (last value wins for a
// repeated name, matching how the store already models headers).
function collectHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => { out[k] = v; });
  return out;
}

function classifyError(e: unknown): string {
  if (e instanceof Error && e.name === 'AbortError') return 'timeout';
  return 'network';
}

// Validate the request body shape without trusting the caller. Returns the parsed
// request or a 400 result.
function parseRequest(body: unknown): ReplayRequest | { ok: false; code: 400; message: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, code: 400, message: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b.deviceId !== 'string' || b.deviceId === '') return { ok: false, code: 400, message: 'deviceId is required' };
  if (typeof b.id !== 'string' || b.id === '') return { ok: false, code: 400, message: 'id is required' };
  let credentials: ReplayCredentials | undefined;
  if (b.credentials !== undefined) {
    if (b.credentials !== 'strip' && b.credentials !== 'keep') return { ok: false, code: 400, message: "credentials must be 'strip' or 'keep'" };
    credentials = b.credentials;
  }
  let overrides: ReplayOverrides | undefined;
  if (b.overrides !== undefined) {
    if (typeof b.overrides !== 'object' || b.overrides === null) return { ok: false, code: 400, message: 'overrides must be an object' };
    const o = b.overrides as Record<string, unknown>;
    if (o.method !== undefined && typeof o.method !== 'string') return { ok: false, code: 400, message: 'overrides.method must be a string' };
    if (o.url !== undefined && typeof o.url !== 'string') return { ok: false, code: 400, message: 'overrides.url must be a string' };
    if (o.body !== undefined && typeof o.body !== 'string') return { ok: false, code: 400, message: 'overrides.body must be a string' };
    if (o.headers !== undefined) {
      if (typeof o.headers !== 'object' || o.headers === null) return { ok: false, code: 400, message: 'overrides.headers must be an object' };
      for (const v of Object.values(o.headers as Record<string, unknown>)) {
        if (typeof v !== 'string') return { ok: false, code: 400, message: 'overrides.headers values must be strings' };
      }
    }
    overrides = o as ReplayOverrides;
  }
  return { deviceId: b.deviceId, id: b.id, credentials, overrides };
}

// Re-send the request behind `deviceId/id` (with any overrides) and store the
// response as a new `replay` entry. `deps.fetch` is injectable for tests. The
// caller (POST /api/replay) maps the result code to an HTTP status: ok → 201,
// else the `code`.
export async function performReplay(
  store: Store,
  requestBody: unknown,
  deps: { fetch?: typeof fetch } = {},
): Promise<ReplayResult> {
  const parsed = parseRequest(requestBody);
  if ('ok' in parsed && parsed.ok === false) return parsed;
  const { deviceId, id, overrides = {}, credentials = 'strip' } = parsed as ReplayRequest & { overrides: ReplayOverrides };

  const original = store.entry(deviceId, id);
  if (!original) return { ok: false, code: 404, message: 'entry not found' };

  const method = (overrides.method ?? original.method).toUpperCase();
  // Resolve the request line, then (default) drop captured credentials before the
  // request leaves. Headers the caller passed explicitly are protected from the
  // strip. Any credential the strip removes is recorded in `stripped` and echoed
  // back on the result and the new entry's `replayOf`.
  let url = overrides.url ?? original.url;
  let resolvedHeaders = overrides.headers ?? original.requestHeaders;
  const stripped: string[] = [];
  if (credentials === 'strip') {
    const protectedNames = new Set(Object.keys(overrides.headers ?? {}).map((k) => k.toLowerCase()));
    const s = stripCredentials(resolvedHeaders, url, protectedNames);
    resolvedHeaders = s.headers; url = s.url; stripped.push(...s.stripped);
  }
  const headers = stripHeaders(resolvedHeaders);

  // Resolve the request body to send. An override always wins. Otherwise the
  // original text body is reused — but if it was never captured as recoverable
  // text (omitted for size/budget/binary/not-captured) there is nothing to send,
  // so the replay is rejected 422 unless the caller supplies an override.
  let bodyText: string | null;
  if (overrides.body !== undefined) {
    bodyText = overrides.body;
  } else if (original.requestBodyOmitted != null) {
    return { ok: false, code: 422, message: `original request body is not replayable (${original.requestBodyOmitted}); provide an override body` };
  } else {
    bodyText = original.requestBody;
  }

  const sendBody = !BODYLESS.has(method) && bodyText != null ? bodyText : undefined;

  const doFetch = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS);
  const startedAt = Date.now();
  let res: Response | null = null;
  let error: string | null = null;
  try {
    res = await doFetch(url, { method, headers, body: sendBody, redirect: 'manual', signal: controller.signal });
  } catch (e) {
    error = classifyError(e);
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Date.now() - startedAt;

  const responseBytes = res ? new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0))) : null;
  const requestBytes = sendBody != null ? Buffer.from(sendBody, 'utf8') : null;
  const newId = `replay-${randomBytes(8).toString('hex')}`;

  const input: EntryInput = {
    id: newId, deviceId, source: 'replay', startedAt,
    method, url,
    requestHeaders: headers, requestBytes, requestBodySize: requestBytes?.length ?? 0, requestBodyOmitted: null,
    status: res ? res.status : null, statusText: res ? res.statusText : '',
    responseHeaders: res ? collectHeaders(res) : {},
    responseBytes, responseBodySize: responseBytes?.length ?? 0,
    responseBodyOmitted: responseBytes && !isUtf8(responseBytes) ? 'binary' : null,
    durationMs, error,
    replayOf: { id, credentials, stripped },
  };
  store.addEntryInput(input);

  return { ok: true, key: { deviceId, id: newId }, status: res ? res.status : null, durationMs, error, stripped };
}
