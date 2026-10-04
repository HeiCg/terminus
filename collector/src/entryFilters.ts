import type { DeviceScopeFilter } from './store.js';
import type { EntrySummary } from './uiProtocol.js';
import type { Source } from './types.js';

// P4: the server-side entry filters shared by `GET /api/entries` (afterSeq/last)
// and the long-poll `GET /api/entries/wait` (entryWait.ts).

// The closed set of entry sources. A Record over `Source` makes the compiler
// reject this list the day a source is added without it.
const SOURCES: Record<Source, true> = { xhr: true, atlantis: true, proxy: true, replay: true };
export const FILTER_PARAMS = ['method', 'urlContains', 'status', 'source', 'completed'] as const;
const URL_CONTAINS_MAX = 512;
// An HTTP method is an RFC 9110 token.
const METHOD_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export type EntryMatch = (e: EntrySummary) => boolean;
export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

// Whether the query names any of the P4 filters (used to refuse them outside the
// afterSeq/last modes instead of silently ignoring them).
export function hasEntryFilters(q: URLSearchParams): boolean {
  return FILTER_PARAMS.some((p) => q.has(p));
}

// Parse the P4 filters into one predicate over the summary (undefined when none
// is given). Every value is strict: an empty, repeated or malformed parameter is
// an error, never a filter that silently matches everything. They AND together.
export function parseEntryFilters(q: URLSearchParams): Parsed<EntryMatch | undefined> {
  const preds: EntryMatch[] = [];
  const bad = (message: string): Parsed<never> => ({ ok: false, message });
  for (const p of FILTER_PARAMS) if (q.getAll(p).length > 1) return bad(`${p} may be given once`);

  const method = q.get('method');
  if (method !== null) {
    const want = new Set(method.split(',').map((m) => m.trim().toUpperCase()));
    if ([...want].some((m) => !METHOD_TOKEN.test(m))) return bad('method must be a method name or a comma list of them');
    preds.push((e) => want.has(e.method.toUpperCase()));
  }
  const urlContains = q.get('urlContains');
  if (urlContains !== null) {
    if (urlContains.length === 0 || urlContains.length > URL_CONTAINS_MAX) return bad(`urlContains must be 1 to ${URL_CONTAINS_MAX} characters`);
    const needle = urlContains.toLowerCase();
    preds.push((e) => e.url.toLowerCase().includes(needle));
  }
  const status = q.get('status');
  if (status !== null) {
    const range = parseStatus(status);
    if (!range) return bad('status must be a code (201), a class (2xx) or an inclusive range (200-299)');
    const [lo, hi] = range;
    // An entry without a status (in flight, or failed) never matches.
    preds.push((e) => e.status != null && e.status >= lo && e.status <= hi);
  }
  const source = q.get('source');
  if (source !== null) {
    if (!Object.hasOwn(SOURCES, source)) return bad(`source must be one of ${Object.keys(SOURCES).join(', ')}`);
    preds.push((e) => e.source === source);
  }
  const completed = q.get('completed');
  if (completed !== null) {
    if (completed !== 'true' && completed !== 'false') return bad('completed must be true or false');
    // Completed = carries a status OR an error (a transport failure is final too).
    const want = completed === 'true';
    preds.push((e) => (e.status != null || e.error != null) === want);
  }
  if (preds.length === 0) return { ok: true, value: undefined };
  return { ok: true, value: (e) => preds.every((p) => p(e)) };
}

// `201` | `2xx` | `200-299` -> the inclusive [lo, hi] it selects, or null.
function parseStatus(raw: string): [number, number] | null {
  const code = /^[1-5]\d\d$/;
  if (code.test(raw)) return [Number(raw), Number(raw)];
  const cls = /^([1-5])xx$/i.exec(raw);
  if (cls) return [Number(cls[1]) * 100, Number(cls[1]) * 100 + 99];
  const [lo, hi, ...rest] = raw.split('-');
  if (rest.length > 0 || hi === undefined || !code.test(lo) || !code.test(hi)) return null;
  return Number(lo) <= Number(hi) ? [Number(lo), Number(hi)] : null;
}

// The device-scope filters (P2) from a query. An empty value is treated as
// absent, like the legacy `device=`.
export function deviceScopeFilter(q: URLSearchParams): DeviceScopeFilter {
  return { device: q.get('device') || undefined, externalId: q.get('externalId') || undefined, bundleId: q.get('bundleId') || undefined };
}

// A strict non-negative integer parameter, or null when malformed.
export function nonNegIntParam(q: URLSearchParams, name: string): number | null {
  const raw = q.get(name) ?? '';
  const n = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(n) ? n : null;
}
