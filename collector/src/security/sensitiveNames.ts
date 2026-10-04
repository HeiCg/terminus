import { env } from '../env.js';

// P5: the single source of truth for "is this name a credential?", shared by the
// ingest redactor (redactor.ts) and the replay credential strip (replay.ts).
//
// Matching is by WORD, not substring: a name is split into words (camelCase,
// `_`, `-`, `.`, spaces, letter/digit boundaries), lowercased, and is sensitive
// when any word is in WORDS (or is a simple plural of one: one trailing `s`, so
// `tokens`, `secrets`, `cookies` match), when two adjacent words form a PAIR
// (`api`+`key`, `card`+`number`), or when a word is a SQUASHED form written with
// no separator (`apikey`, `accesstoken`, `sessionid`, `setcookie`). A substring
// rule would have masked `shipping` (pin), `discard` (card) and `author` (auth).
//
// The pre-P5 lists are kept verbatim per kind so nothing redacted before stops
// being redacted (LEGACY_*), and the operator can widen or narrow the set with
// TERMINUS_REDACT_EXTRA / TERMINUS_REDACT_ALLOW (configureRedaction).

export type NameKind = 'header' | 'query' | 'body';

const WORDS = new Set([
  'password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'auth', 'authorization', 'session', 'sessionid',
  'credential', 'credentials', 'otp', 'pin', 'cvv', 'cvc', 'signature', 'sig', 'cookie',
]);
const SQUASHED = new Set(['apikey', 'accesstoken', 'sessionid', 'setcookie']);
const PAIRS: readonly (readonly [string, string])[] = [['api', 'key'], ['card', 'number']];

// The pre-P5 redactor lists. Headers and query matched whole names; the body regex
// was not anchored on the left, so any key ENDING in one of its names matched.
const LEGACY_HEADERS = new Set(['access-token', 'client', 'uid']);
const LEGACY_QUERY = new Set(['access_token', 'client_id', 'uid']);
const LEGACY_BODY = /(?:access[_-]?token|client|authorization|uid|password)$/i;

// Names TERMINUS_REDACT_ALLOW can never exempt.
const NEVER_EXEMPT = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);

let extra = new Set<string>();
let allow = new Set<string>();

// Install the operator's extra/allow lists (whole names, case-insensitive). Called
// once at startup by main.ts; tests call it directly and reset with `{}`.
export function configureRedaction(c: { extra?: readonly string[]; allow?: readonly string[] }): void {
  extra = new Set((c.extra ?? []).map((n) => n.toLowerCase()));
  allow = new Set((c.allow ?? []).map((n) => n.toLowerCase()));
}

export function parseNameList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

// TERMINUS_REDACT_EXTRA / TERMINUS_REDACT_ALLOW (deprecated NETCAPTURE_ spellings
// honoured by env()), comma-separated.
export function redactionConfigFromEnv(): { extra: string[]; allow: string[] } {
  return { extra: parseNameList(env('REDACT_EXTRA')), allow: parseNameList(env('REDACT_ALLOW')) };
}

// Split a name into lowercase words on separators, camelCase (`nextPageToken`,
// `APIKey`) and letter/digit boundaries (`otp2` -> otp, 2).
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const singular = (w: string): string => (w.length > 1 && w.endsWith('s') ? w.slice(0, -1) : w);
const isListed = (w: string): boolean => WORDS.has(w) || SQUASHED.has(w);

function hasSensitiveWord(name: string): boolean {
  const words = nameWords(name);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (isListed(w) || isListed(singular(w))) return true;
    const next = words[i + 1];
    if (next != null && PAIRS.some(([a, b]) => w === a && singular(next) === b)) return true;
  }
  return false;
}

function isLegacy(lower: string, kind: NameKind): boolean {
  if (kind === 'header') return LEGACY_HEADERS.has(lower);
  if (kind === 'query') return LEGACY_QUERY.has(lower);
  return LEGACY_BODY.test(lower);
}

// The built-in verdict is static, and a JSON body repeats the same keys many times,
// so it is memoized; the map is simply dropped when it reaches MEMO_MAX names.
const MEMO_MAX = 4096;
const memo = new Map<string, boolean>();
function builtIn(name: string, lower: string, kind: NameKind): boolean {
  const k = `${kind}\u0000${name}`;
  let v = memo.get(k);
  if (v === undefined) {
    v = isLegacy(lower, kind) || hasSensitiveWord(name);
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(k, v);
  }
  return v;
}

// Whether a header name, query parameter name or body key names a credential whose
// value must be masked. Precedence: NEVER_EXEMPT > allow > extra > built-in rules.
export function isSensitiveName(name: string, kind: NameKind): boolean {
  const lower = name.toLowerCase();
  if (NEVER_EXEMPT.has(lower)) return true;
  if (allow.has(lower)) return false;
  if (extra.has(lower)) return true;
  return builtIn(name, lower, kind);
}
