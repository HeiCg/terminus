// The Capture search box speaks a small `key:value` mini-query on top of a free
// substring. This module is the PURE parser + matcher: it knows nothing about
// Svelte, the Store, or the body cache — `Filters` composes it with the chip
// filters (AND). Keeping it pure is what lets `query.test.ts` cover the grammar
// exhaustively without standing up any reactive state.
//
// Grammar: whitespace-separated tokens. A token shaped `key:value` whose key is
// one of the known keys is a typed term; any other token (a bare word, a quoted
// phrase, or an unknown key) is a free substring term. Double quotes let a value
// (or a free term) contain spaces: `host:"api v2"` or `"two words"`. `method` and
// `status` accept a comma-separated list (OR); the other keys take one value, and
// repeating a key ORs the repeats. Free terms are ANDed and matched against the
// row's method + url. Typed terms are ANDed across keys.

// The row fields the matcher reads. `Filters`' `Row` is a structural superset, so
// it satisfies this without a cast; a plain object works in tests.
export interface QueryRow {
  method: string;
  status: number | null;
  host: string;
  path: string;
  source: string;
  deviceId: string;
  url: string;
}

// A single status term compiled to a predicate over an HTTP status code: an exact
// code (`404`), a class (`5xx`), or an inclusive range (`400-499`).
type StatusMatcher = (status: number) => boolean;

export interface ParsedQuery {
  method: string[]; // lowercased method names (OR)
  status: StatusMatcher[]; // OR
  host: string[]; // lowercased substrings (OR)
  path: string[]; // lowercased substrings (OR)
  source: string[]; // lowercased exact source ids (OR)
  device: string[]; // lowercased substrings of deviceId (OR)
  body: string[]; // lowercased substrings, matched against a supplied body accessor (OR)
  free: string[]; // lowercased substrings matched against method + url (AND)
}

const KNOWN_KEYS = new Set(['method', 'status', 'host', 'path', 'source', 'device', 'body']);

// Split the raw input into tokens on unquoted whitespace, dropping the quote
// characters themselves so a quoted run keeps its spaces. `host:"api v2"` yields
// the single token `host:api v2`; `"a b" c` yields `a b` then `c`.
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inQuote = false;
  let has = false; // did the current run have any (possibly empty-quoted) content
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuote = !inQuote;
      has = true;
      continue;
    }
    if (ch === ' ' && !inQuote) {
      if (has) tokens.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) tokens.push(cur);
  return tokens;
}

// Compile one status value string to a predicate, or null when it is not a valid
// code / class / range (such a value is simply ignored rather than matching all).
function statusMatcher(value: string): StatusMatcher | null {
  const v = value.trim().toLowerCase();
  if (/^\d{3}$/.test(v)) {
    const code = Number(v);
    return (s) => s === code;
  }
  const cls = /^([1-5])xx$/.exec(v);
  if (cls) {
    const hundreds = Number(cls[1]);
    return (s) => Math.floor(s / 100) === hundreds;
  }
  const range = /^(\d{3})-(\d{3})$/.exec(v);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    const min = Math.min(lo, hi);
    const max = Math.max(lo, hi);
    return (s) => s >= min && s <= max;
  }
  return null;
}

export function parseQuery(input: string): ParsedQuery {
  const q: ParsedQuery = { method: [], status: [], host: [], path: [], source: [], device: [], body: [], free: [] };
  for (const tok of tokenize(input)) {
    const colon = tok.indexOf(':');
    const key = colon > 0 ? tok.slice(0, colon).toLowerCase() : '';
    if (colon > 0 && KNOWN_KEYS.has(key)) {
      const raw = tok.slice(colon + 1);
      if (raw === '') continue; // `host:` with no value is a no-op, not a free term
      switch (key) {
        case 'method':
          for (const m of raw.split(',')) if (m) q.method.push(m.toLowerCase());
          break;
        case 'status':
          for (const s of raw.split(',')) {
            const m = statusMatcher(s);
            if (m) q.status.push(m);
          }
          break;
        case 'host':
          q.host.push(raw.toLowerCase());
          break;
        case 'path':
          q.path.push(raw.toLowerCase());
          break;
        case 'source':
          q.source.push(raw.toLowerCase());
          break;
        case 'device':
          q.device.push(raw.toLowerCase());
          break;
        case 'body':
          q.body.push(raw.toLowerCase());
          break;
        default:
          break;
      }
      continue;
    }
    // Bare word, quoted phrase, or unknown key → free substring term.
    q.free.push(tok.toLowerCase());
  }
  return q;
}

// True when nothing was typed (every field empty) — lets callers short-circuit.
export function isEmptyQuery(q: ParsedQuery): boolean {
  return (
    q.method.length === 0 &&
    q.status.length === 0 &&
    q.host.length === 0 &&
    q.path.length === 0 &&
    q.source.length === 0 &&
    q.device.length === 0 &&
    q.body.length === 0 &&
    q.free.length === 0
  );
}

// Match a row against a parsed query. `bodyText` supplies the (already lowercased
// or raw) body text for a `body:` term; when omitted, a `body:` term matches
// nothing (the caller has no resident bodies to scan).
export function matchQuery<R extends QueryRow>(
  q: ParsedQuery,
  row: R,
  bodyText?: (row: R) => string | null,
): boolean {
  if (q.method.length && !q.method.includes(row.method.toLowerCase())) return false;
  if (q.status.length && !(row.status != null && q.status.some((m) => m(row.status as number)))) return false;
  if (q.host.length) {
    const host = row.host.toLowerCase();
    if (!q.host.some((h) => host.includes(h))) return false;
  }
  if (q.path.length) {
    const path = row.path.toLowerCase();
    if (!q.path.some((p) => path.includes(p))) return false;
  }
  if (q.source.length && !q.source.includes(row.source.toLowerCase())) return false;
  if (q.device.length) {
    const dev = row.deviceId.toLowerCase();
    if (!q.device.some((d) => dev.includes(d))) return false;
  }
  if (q.body.length) {
    const text = bodyText?.(row);
    if (text == null) return false;
    const hay = text.toLowerCase();
    if (!q.body.some((b) => hay.includes(b))) return false;
  }
  if (q.free.length) {
    const hay = `${row.method} ${row.url}`.toLowerCase();
    if (!q.free.every((t) => hay.includes(t))) return false;
  }
  return true;
}
