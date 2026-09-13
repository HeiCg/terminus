import type { Config } from './config.js';
import { authError, generalError, unreachableError, CliError } from './errors.js';

// The HTTP surface the commands use. Every call carries the admin bearer; the
// collector accepts a bearer without an Origin on loopback, so GETs and the small
// POST mutations need no Origin (only the /ui socket does). A transport failure
// (the collector is not listening) becomes an exit-3 CliError with the run hint; a
// 401/403 becomes exit 2; any other non-2xx becomes exit 1.

function authHeader(config: Config): Record<string, string> {
  return { authorization: `Bearer ${config.token}` };
}

async function request(config: Config, pathAndQuery: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(config.baseUrl + pathAndQuery, {
      ...init,
      headers: { ...authHeader(config), ...(init?.headers ?? {}) },
    });
  } catch {
    // Any transport error (ECONNREFUSED, reset, DNS) means the collector is not
    // reachable at this host/port.
    throw unreachableError(config.host, config.port);
  }
  if (res.status === 401 || res.status === 403) {
    throw authError('authentication failed — check --token / TERMINUS_TOKEN, or restart the collector');
  }
  return res;
}

// Non-2xx (after the auth statuses are handled) is a general error naming the route.
async function ok(res: Response, method: string, pathAndQuery: string): Promise<Response> {
  if (res.status < 200 || res.status >= 300) {
    const body = (await res.text().catch(() => '')).trim();
    const detail = body ? `: ${body.slice(0, 200)}` : '';
    throw generalError(`${method} ${pathAndQuery} -> ${res.status}${detail}`);
  }
  return res;
}

export async function getJson<T = any>(config: Config, pathAndQuery: string): Promise<T> {
  const res = await ok(await request(config, pathAndQuery), 'GET', pathAndQuery);
  return res.json() as Promise<T>;
}

// Like getJson, but a 404 resolves to null instead of erroring — for routes an older
// collector may not serve (GET /api/status), so a new CLI degrades gracefully rather
// than failing. Auth failures (401/403) and other non-2xx still throw.
export async function getJsonOr404<T = any>(config: Config, pathAndQuery: string): Promise<T | null> {
  const res = await request(config, pathAndQuery);
  if (res.status === 404) { await res.arrayBuffer().catch(() => undefined); return null; }
  await ok(res, 'GET', pathAndQuery);
  return res.json() as Promise<T>;
}

// Fetch one body route: null for 404 (no such record), the omission reason for a 410
// (body dropped), or the decoded text/bytes. The collector serves octet-stream for a
// binary body and text/plain otherwise.
export type BodyResult =
  | { kind: 'missing' }
  | { kind: 'omitted'; reason: string }
  | { kind: 'bytes'; contentType: string; bytes: Uint8Array };

export async function getBody(config: Config, pathAndQuery: string): Promise<BodyResult> {
  const res = await request(config, pathAndQuery);
  if (res.status === 404) return { kind: 'missing' };
  if (res.status === 410) {
    const reason = res.headers.get('x-body-omitted') ?? 'unknown';
    await res.arrayBuffer().catch(() => undefined);
    return { kind: 'omitted', reason };
  }
  await ok(res, 'GET', pathAndQuery);
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  return { kind: 'bytes', contentType, bytes: new Uint8Array(await res.arrayBuffer()) };
}

export async function postJson<T = any>(config: Config, pathAndQuery: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await ok(await request(config, pathAndQuery, init), 'POST', pathAndQuery);
  const text = (await res.text()).trim();
  return (text ? JSON.parse(text) : {}) as T;
}

// The raw Response for a streaming download (export); the caller pipes the body.
export async function getStream(config: Config, pathAndQuery: string): Promise<Response> {
  return ok(await request(config, pathAndQuery), 'GET', pathAndQuery);
}

export { CliError };
