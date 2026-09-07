import type { Entry } from './types.js';
const HEADERS = new Set(['access-token', 'client', 'authorization', 'cookie', 'set-cookie', 'uid']);
const QUERY = new Set(['access_token', 'client_id', 'uid']);
export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = HEADERS.has(k.toLowerCase()) ? '***' : v;
  return out;
}
export function redactUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  let changed = false;
  for (const k of [...u.searchParams.keys()]) if (QUERY.has(k)) { u.searchParams.set(k, '***'); changed = true; }
  return changed ? u.toString() : url;
}
// Masks values of sensitive keys embedded in a text/JSON body (e.g. an ActionCable
// subscribe frame carrying access_token / uid). Escaped quotes (\") are handled so
// that a JSON string nested inside another JSON string is still covered.
const TEXT_KEY = /(\\?["']?(?:access[_-]?token|client|authorization|uid|password)\\?["']?\s*[:=]\s*\\?["'])([^"'\\]*)/gi;
export function redactText(s: string | null): string | null {
  if (s == null) return s;
  return s.replace(TEXT_KEY, (_m, p1) => `${p1}***`);
}
export function redactEntry(e: Entry): Entry {
  return { ...e, url: redactUrl(e.url), requestHeaders: redactHeaders(e.requestHeaders), responseHeaders: redactHeaders(e.responseHeaders) };
}
