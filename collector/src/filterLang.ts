import type { EntrySummary } from './uiProtocol.js';

// The Terminus filter language (0.3.0): a Wireshark-style expression over HTTP
// entry summaries, shared by the UI search box and the read API's `q=` parameter.
// PURE: no Node or DOM import (the UI bundles it through ui/src/lib/filterLang.ts),
// only the `URL` global both runtimes have.
//
//   expr    := or
//   or      := and (('or' | '||') and)*
//   and     := unary (('and' | '&&')? unary)*        juxtaposition is an implicit AND
//   unary   := ('not' | '!') unary | primary
//   primary := '(' expr ')' | key:value | "text" | field op value | field 'in' '{' value (',' value)* '}'
//            | field (existence/truthiness) | word (text search over method + url)
//   op      := '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | '~' | 'matches'
//
// Compatibility with the 0.2 mini-query: an input with no operator, keyword or
// bracket (the only shapes 0.2 knew) is read exactly the 0.2 way: `key:value`
// terms grouped per key (repeats OR, keys AND), every other token a text search,
// invalid `status:` values ignored, nothing is an error. The one addition is that
// a lone DOTTED field name (`redacted.request`, `http.response`) is a field test,
// since no 0.2 user typed those as text. A lone undotted field (`error`) stays a
// text search there; `(error)` or any operator switches to the expression reading.
// Free text that contains expression syntax (a bracket, `!`, `~`, `<`, `>`, `==`,
// `&&`, `||` outside quotes) or a bare keyword (and/or/not/in/contains/matches)
// is read as an expression, so such a 0.2 search must now be quoted.
//
// Cost: compile is linear in the input; a predicate walks the AST once per entry
// (at most FILTER_MAX_NODES nodes), each node linear in the field it reads, glob
// `matches` O(field x pattern) with no backtracking. No user regex is ever built.

export const FILTER_MAX_LENGTH = 2048;
export const FILTER_MAX_DEPTH = 32;
export const FILTER_MAX_NODES = 512;

export type FilterError = { message: string; offset: number };
export type FilterOp = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'matches' | 'in';
export type FilterValue = { text: string; pos: number };
export type FilterNode =
  | { type: 'true' }
  | { type: 'and' | 'or'; items: FilterNode[] }
  | { type: 'not'; item: FilterNode }
  // Case-insensitive substring of `${method} ${url}` (the 0.2 free term).
  | { type: 'text'; value: string; pos: number }
  | { type: 'exists'; field: string; pos: number }
  | { type: 'cmp'; field: string; op: FilterOp; values: FilterValue[]; pos: number };

// What a predicate reads: the summary, plus the UI's memoized url split when the
// caller has it (the Capture `Row`), so `host`/`path` mean exactly the columns.
export type FilterSubject = EntrySummary & { host?: string; path?: string };
export type FilterHeaders = { requestHeaders: Record<string, string>; responseHeaders: Record<string, string> };

// Optional context a predicate consults lazily, per entry, only for the fields
// the expression names. Absent hooks make their fields match nothing.
export interface MatchEnv {
  // Clock for relative times (`time > -5m`); defaults to Date.now() per call.
  now?: number;
  // Extra identity strings `device` also matches (aliases, externalId, bundleId).
  deviceNames?: (deviceId: string) => readonly string[];
  // Body text for `body` (the UI's resident body cache).
  bodyText?: (e: EntrySummary) => string | null;
  // Headers for `header.*`, `req.header.*`, `res.header.*` and `mime.res`.
  detail?: (e: EntrySummary) => FilterHeaders | null;
}

export type FilterPredicate = (e: FilterSubject, env?: MatchEnv) => boolean;

// Which fields a host can evaluate. The UI list has no headers (they come with
// the detail route); the server does not scan bodies on a read.
export type FilterCaps = { detail: boolean; body: boolean };
export const UI_FILTER_CAPS: FilterCaps = { detail: false, body: true };
export const API_FILTER_CAPS: FilterCaps = { detail: true, body: false };

export type ParseResult = { ok: true; ast: FilterNode; legacy: boolean } | { ok: false; error: FilterError };
export type CompileResult = { ok: true; match: FilterPredicate } | { ok: false; error: FilterError };
// `match` is null for an empty input (nothing to filter).
export type BuildResult = { ok: true; match: FilterPredicate | null; legacy: boolean } | { ok: false; error: FilterError };

class Fail extends Error {
  constructor(message: string, readonly offset: number) { super(message); }
}
const fail = (message: string, offset: number): never => { throw new Fail(message, offset); };

export function formatFilterError(e: FilterError): string {
  return `${e.message} (at offset ${e.offset})`;
}

// ---- fields ----------------------------------------------------------------

type Kind = 'string' | 'strings' | 'number' | 'status' | 'size' | 'duration' | 'time' | 'bool';
type FieldValue = string | readonly string[] | number | boolean | null;
type Spec = { kind: Kind; need?: 'detail' | 'body'; get: (c: Ctx) => FieldValue };

const STATIC_FIELDS: Record<string, Spec> = {
  method: { kind: 'string', get: (c) => c.e.method },
  url: { kind: 'string', get: (c) => c.e.url },
  host: { kind: 'string', get: (c) => c.split().host },
  path: { kind: 'string', get: (c) => c.split().path },
  query: { kind: 'string', get: (c) => c.url()?.search.replace(/^\?/, '') ?? null },
  scheme: { kind: 'string', get: (c) => c.url()?.protocol.replace(/:$/, '') ?? null },
  port: { kind: 'number', get: (c) => portOf(c.url()) },
  status: { kind: 'status', get: (c) => c.e.status },
  source: { kind: 'string', get: (c) => c.e.source },
  device: { kind: 'strings', get: (c) => c.devices() },
  'device.id': { kind: 'string', get: (c) => c.e.deviceId },
  duration: { kind: 'duration', get: (c) => c.e.durationMs },
  'size.req': { kind: 'size', get: (c) => c.e.requestBody?.size ?? null },
  'size.res': { kind: 'size', get: (c) => c.e.responseBody?.size ?? null },
  time: { kind: 'time', get: (c) => c.e.startedAt },
  seq: { kind: 'number', get: (c) => c.e.seq ?? null },
  completed: { kind: 'bool', get: (c) => c.e.status != null || c.e.error != null },
  error: { kind: 'string', get: (c) => c.e.error || null },
  'redacted.request': { kind: 'bool', get: (c) => c.e.redacted?.request === true },
  'redacted.response': { kind: 'bool', get: (c) => c.e.redacted?.response === true },
  'http.response': { kind: 'bool', get: (c) => c.e.status != null },
  'mime.res': { kind: 'string', need: 'detail', get: (c) => c.mime() },
  body: { kind: 'string', need: 'body', get: (c) => c.body() },
};
// `header.<name>` (either side), `req.header.<name>`, `res.header.<name>`; the
// name is an RFC 9110 token.
const HEADER_FIELD = /^(req\.|res\.)?header\.([!#$%&'*+.^_`|~0-9a-z-]+)$/;

// The canonical (lowercased) field name, or null when `name` is not a field.
export function canonicalField(name: string): string | null {
  const lower = name.toLowerCase();
  if (Object.hasOwn(STATIC_FIELDS, lower) || HEADER_FIELD.test(lower)) return lower;
  return null;
}

function specOf(field: string): Spec {
  const s = Object.hasOwn(STATIC_FIELDS, field) ? STATIC_FIELDS[field] : undefined;
  if (s) return s;
  const m = HEADER_FIELD.exec(field);
  if (!m) throw new Error(`not a field: ${field}`);
  const side = m[1] === 'req.' ? 'request' : m[1] === 'res.' ? 'response' : 'both';
  const name = m[2];
  return { kind: 'strings', need: 'detail', get: (c) => c.headers(side, name) };
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };
function portOf(u: URL | null): number | null {
  if (!u) return null;
  if (u.port) return Number(u.port);
  return Object.hasOwn(DEFAULT_PORTS, u.protocol) ? DEFAULT_PORTS[u.protocol] : null;
}

// Same split as the UI's `splitUrl` (format.ts): host with port, path with query.
function splitUrl(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: `${u.pathname}${u.search}` };
  } catch {
    return { host: '', path: url };
  }
}

function headerValues(h: Record<string, string> | undefined, name: string, out: string[]): void {
  if (!h) return;
  for (const k of Object.keys(h)) if (k.toLowerCase() === name) out.push(h[k]);
}

// Per-entry evaluation context: each derived value is computed at most once per
// predicate call, and only when the expression reads it.
class Ctx {
  #split?: { host: string; path: string };
  #url?: URL | null;
  #hay?: string;
  #detail?: FilterHeaders | null;
  #body?: string | null;
  #now?: number;
  constructor(readonly e: FilterSubject, readonly env: MatchEnv | undefined) {}

  split(): { host: string; path: string } {
    if (!this.#split) {
      const { host, path } = this.e;
      this.#split = typeof host === 'string' && typeof path === 'string' ? { host, path } : splitUrl(this.e.url);
    }
    return this.#split;
  }
  url(): URL | null {
    if (this.#url === undefined) {
      try { this.#url = new URL(this.e.url); } catch { this.#url = null; }
    }
    return this.#url;
  }
  hay(): string {
    this.#hay ??= `${this.e.method} ${this.e.url}`.toLowerCase();
    return this.#hay;
  }
  now(): number {
    this.#now ??= this.env?.now ?? Date.now();
    return this.#now;
  }
  devices(): readonly string[] {
    const extra = this.env?.deviceNames?.(this.e.deviceId);
    return extra && extra.length ? [this.e.deviceId, ...extra] : [this.e.deviceId];
  }
  detail(): FilterHeaders | null {
    if (this.#detail === undefined) this.#detail = this.env?.detail?.(this.e) ?? null;
    return this.#detail;
  }
  headers(side: 'request' | 'response' | 'both', name: string): string[] {
    const d = this.detail();
    const out: string[] = [];
    if (!d) return out;
    if (side !== 'response') headerValues(d.requestHeaders, name, out);
    if (side !== 'request') headerValues(d.responseHeaders, name, out);
    return out;
  }
  mime(): string | null {
    const ct = this.headers('response', 'content-type')[0];
    if (ct == null) return null;
    const t = ct.split(';')[0].trim();
    return t || null;
  }
  body(): string | null {
    if (this.#body === undefined) this.#body = this.env?.bodyText?.(this.e) ?? null;
    return this.#body;
  }
}

// ---- lexer -----------------------------------------------------------------

type TokKind = 'word' | 'str' | 'kv' | 'op' | 'and' | 'or' | 'not' | '(' | ')' | '{' | '}' | ',' | 'eof';
type Tok = { k: TokKind; v: string; pos: number; op?: FilterOp; key?: LegacyKey; vpos?: number };

const LEGACY_KEYS = ['method', 'status', 'host', 'path', 'source', 'device', 'body'] as const;
type LegacyKey = (typeof LEGACY_KEYS)[number];
const LEGACY_KEY = /^(method|status|host|path|source|device|body):/i;
// Characters that end a bare word (a comma also does, outside a key:value term).
const SPECIAL = '(){}!=<>~&|"';
const WS = /\s/;
const KEYWORD_OPS: Record<string, FilterOp> = { contains: 'contains', matches: 'matches', in: 'in' };
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r' };

// A double-quoted string starting at `i`; returns the unescaped text and the
// offset just past the closing quote.
function readString(src: string, i: number): [string, number] {
  let out = '';
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '"') return [out, j + 1];
    if (ch === '\\') {
      if (j + 1 >= src.length) break;
      const next = src[j + 1];
      if (!Object.hasOwn(ESCAPES, next)) fail(`unknown escape '\\${next}' (use \\", \\\\, \\n, \\t or \\r)`, j);
      out += ESCAPES[next];
      j += 2;
      continue;
    }
    out += ch;
    j += 1;
  }
  return fail('unterminated string', i);
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  const op = (v: string, o: FilterOp, pos: number) => toks.push({ k: 'op', v, op: o, pos });
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (WS.test(ch)) { i += 1; continue; }
    const two = src.slice(i, i + 2);
    switch (ch) {
      case '(': case ')': case '{': case '}': case ',':
        toks.push({ k: ch, v: ch, pos: i }); i += 1; continue;
      case '=':
        if (two !== '==') fail("unexpected '='; compare with ==", i);
        op('==', '==', i); i += 2; continue;
      case '!':
        if (two === '!=') { op('!=', '!=', i); i += 2; } else { toks.push({ k: 'not', v: '!', pos: i }); i += 1; }
        continue;
      case '<': case '>':
        if (src[i + 1] === '=') { op(two, two as FilterOp, i); i += 2; } else { op(ch, ch as FilterOp, i); i += 1; }
        continue;
      case '~':
        op('~', 'contains', i); i += 1; continue;
      case '&': case '|':
        if (two !== ch + ch) fail(`unexpected '${ch}'; use ${ch + ch} or ${ch === '&' ? 'and' : 'or'}`, i);
        toks.push({ k: ch === '&' ? 'and' : 'or', v: two, pos: i }); i += 2; continue;
      case '"': {
        const [text, end] = readString(src, i);
        toks.push({ k: 'str', v: text, pos: i }); i = end; continue;
      }
    }
    // A run of word characters, commas included so a `method:GET,POST` term
    // stays whole; outside a key:value term the word stops at the first comma.
    let j = i;
    while (j < src.length && !WS.test(src[j]) && !SPECIAL.includes(src[j])) j += 1;
    const run = src.slice(i, j);
    const kv = LEGACY_KEY.exec(run);
    if (kv) {
      const key = kv[1].toLowerCase() as LegacyKey;
      const vpos = i + kv[0].length;
      let value = run.slice(kv[0].length);
      let end = j;
      if (value === '' && src[j] === '"') [value, end] = readString(src, j);
      toks.push({ k: 'kv', v: value, key, pos: i, vpos });
      i = end;
      continue;
    }
    const comma = run.indexOf(',');
    const word = comma >= 0 ? run.slice(0, comma) : run;
    const lower = word.toLowerCase();
    if (lower === 'and' || lower === 'or' || lower === 'not') toks.push({ k: lower, v: word, pos: i });
    else if (Object.hasOwn(KEYWORD_OPS, lower)) op(word, KEYWORD_OPS[lower], i);
    else toks.push({ k: 'word', v: word, pos: i });
    i += word.length;
  }
  toks.push({ k: 'eof', v: '', pos: src.length });
  return toks;
}

const describe = (t: Tok): string => (t.k === 'eof' ? 'end of input' : `'${t.v}'`);

// ---- 0.2 key:value terms (shared by both readings) ---------------------------

const STATUS_CODE = /^\d{3}$/;
const STATUS_CLASS = /^([1-5])xx$/i;
const STATUS_RANGE = /^(\d{3})-(\d{3})$/;
const isStatusValue = (v: string): boolean => STATUS_CODE.test(v) || STATUS_CLASS.test(v) || STATUS_RANGE.test(v);

// One `key:value` term as an AST node. `lenient` (the 0.2 reading) drops invalid
// status values and returns null for a term with nothing left, as 0.2 did;
// otherwise an empty term is an error and a bad status value fails at compile.
function keyTerm(key: LegacyKey, raw: string, pos: number, vpos: number, lenient: boolean): FilterNode | null {
  const cmp = (field: string, op: FilterOp, values: FilterValue[]): FilterNode => ({ type: 'cmp', field, op, values, pos });
  if (raw === '') return lenient ? null : fail(`${key}: needs a value`, pos);
  switch (key) {
    case 'method':
    case 'status': {
      const values: FilterValue[] = [];
      let at = vpos;
      for (const piece of raw.split(',')) {
        const text = key === 'status' ? piece.trim() : piece;
        if (text !== '' && (key === 'method' || !lenient || isStatusValue(text))) values.push({ text, pos: at });
        at += piece.length + 1;
      }
      if (values.length === 0) return lenient ? null : fail(`${key}: needs a value`, pos);
      return cmp(key, 'in', values);
    }
    case 'host': return cmp('host', 'contains', [{ text: raw, pos: vpos }]);
    case 'path': return cmp('path', 'contains', [{ text: raw, pos: vpos }]);
    case 'source': return cmp('source', '==', [{ text: raw, pos: vpos }]);
    case 'device': return cmp('device.id', 'contains', [{ text: raw, pos: vpos }]);
    case 'body': return cmp('body', 'contains', [{ text: raw, pos: vpos }]);
  }
}

// ---- parser ----------------------------------------------------------------

class Parser {
  #i = 0;
  #nodes = 0;
  constructor(private readonly toks: Tok[]) {}

  #peek(): Tok { return this.toks[this.#i]; }
  #next(): Tok { return this.toks[this.#i++]; }
  #count(pos: number): void {
    this.#nodes += 1;
    if (this.#nodes > FILTER_MAX_NODES) fail(`expression too large (more than ${FILTER_MAX_NODES} terms)`, pos);
  }

  parse(): FilterNode {
    if (this.#peek().k === 'eof') return { type: 'true' };
    const node = this.#or(0);
    const t = this.#peek();
    if (t.k !== 'eof') fail(`unexpected ${describe(t)}`, t.pos);
    return node;
  }

  #or(depth: number): FilterNode {
    const items = [this.#and(depth)];
    while (this.#peek().k === 'or') {
      this.#next();
      items.push(this.#and(depth));
    }
    if (items.length === 1) return items[0];
    this.#count(this.#peek().pos);
    return { type: 'or', items };
  }

  #and(depth: number): FilterNode {
    const items = [this.#unary(depth)];
    for (;;) {
      const t = this.#peek();
      if (t.k === 'and') { this.#next(); items.push(this.#unary(depth)); continue; }
      if (t.k === 'not' || t.k === '(' || t.k === 'kv' || t.k === 'str' || t.k === 'word') { items.push(this.#unary(depth)); continue; }
      break;
    }
    if (items.length === 1) return items[0];
    this.#count(this.#peek().pos);
    return { type: 'and', items };
  }

  #unary(depth: number): FilterNode {
    const t = this.#peek();
    if (depth >= FILTER_MAX_DEPTH) fail(`expression nested too deeply (more than ${FILTER_MAX_DEPTH} levels)`, t.pos);
    if (t.k === 'not') {
      this.#next();
      this.#count(t.pos);
      return { type: 'not', item: this.#unary(depth + 1) };
    }
    return this.#primary(depth);
  }

  #primary(depth: number): FilterNode {
    const t = this.#next();
    switch (t.k) {
      case '(': {
        if (this.#peek().k === ')') fail("expected an expression inside '( )'", this.#peek().pos);
        const node = this.#or(depth + 1);
        const close = this.#next();
        if (close.k !== ')') fail(close.k === 'eof' ? `missing ')' for the '(' at offset ${t.pos}` : `unexpected ${describe(close)}`, close.pos);
        return node;
      }
      case 'kv':
        this.#count(t.pos);
        return keyTerm(t.key!, t.v, t.pos, t.vpos!, false)!;
      case 'str':
        this.#count(t.pos);
        return { type: 'text', value: t.v, pos: t.pos };
      case 'word':
        return this.#word(t);
      case 'eof':
        return fail('expected an expression', t.pos);
      default:
        return fail(`unexpected ${describe(t)}`, t.pos);
    }
  }

  #word(t: Tok): FilterNode {
    const opTok = this.#peek();
    const field = canonicalField(t.v);
    this.#count(t.pos);
    if (opTok.k !== 'op') return field ? { type: 'exists', field, pos: t.pos } : { type: 'text', value: t.v, pos: t.pos };
    this.#next();
    if (!field) fail(`unknown field '${t.v}'`, t.pos);
    const op = opTok.op!;
    const values = op === 'in' ? this.#set() : [this.#value(opTok)];
    return { type: 'cmp', field: field!, op, values, pos: t.pos };
  }

  #value(after: Tok): FilterValue {
    const v = this.#next();
    if (v.k === 'word' || v.k === 'str') return { text: v.v, pos: v.pos };
    return fail(`expected a value after ${describe(after)}, found ${describe(v)}`, v.pos);
  }

  #set(): FilterValue[] {
    const open = this.#next();
    if (open.k !== '{') fail(`expected '{' after 'in', found ${describe(open)}`, open.pos);
    const values: FilterValue[] = [];
    for (;;) {
      values.push(this.#value(this.toks[this.#i - 1]));
      this.#count(values[values.length - 1].pos);
      const t = this.#next();
      if (t.k === '}') return values;
      if (t.k !== ',') fail(t.k === 'eof' ? `missing '}' for the '{' at offset ${open.pos}` : `expected ',' or '}', found ${describe(t)}`, t.pos);
    }
  }
}

// ---- the 0.2 reading ---------------------------------------------------------

type LegacyToken = { text: string; quoted: boolean; pos: number; syntax: boolean };
const LONE_SYNTAX = '(){}<>~!';
const PAIR_SYNTAX = '=&|';

// The 0.2 tokenizer: split on unquoted spaces and drop the quote characters, so
// a quoted run keeps its spaces. Also notes, per token, whether any expression
// syntax appears outside quotes (which makes the input an expression instead).
function legacyTokens(input: string): LegacyToken[] {
  const out: LegacyToken[] = [];
  let cur = '';
  let inQuote = false;
  let has = false;
  let quoted = false;
  let syntax = false;
  let pos = 0;
  const push = () => { if (has) out.push({ text: cur, quoted, pos, syntax }); };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (!has) pos = i;
    if (ch === '"') { inQuote = !inQuote; has = true; quoted = true; continue; }
    if (ch === ' ' && !inQuote) {
      push();
      cur = ''; has = false; quoted = false; syntax = false;
      continue;
    }
    // Expression syntax: a bracket, comparison or `!`/`~`, or a doubled `==`,
    // `&&`, `||`. A lone `=`, `&` or `|` is no operator, so a query-string
    // search such as `next=/home&x=1` keeps its 0.2 meaning.
    if (!inQuote && (LONE_SYNTAX.includes(ch) || (PAIR_SYNTAX.includes(ch) && input[i + 1] === ch))) syntax = true;
    cur += ch;
    has = true;
  }
  push();
  return out;
}

// Whether the input uses nothing beyond the 0.2 mini-query: no operator, bracket
// or keyword outside quotes and outside a known `key:value` term.
function legacyShape(tokens: LegacyToken[]): boolean {
  for (const t of tokens) {
    if (LEGACY_KEY.test(t.text)) continue;
    if (t.syntax) return false;
    if (!t.quoted && /^(and|or|not|contains|matches|in)$/i.test(t.text)) return false;
  }
  return true;
}

function parseLegacy(tokens: LegacyToken[]): FilterNode {
  const groups = new Map<LegacyKey, FilterNode[]>();
  const rest: FilterNode[] = [];
  let nodes = 0;
  const count = (pos: number) => {
    nodes += 1;
    if (nodes > FILTER_MAX_NODES) fail(`expression too large (more than ${FILTER_MAX_NODES} terms)`, pos);
  };
  for (const t of tokens) {
    const colon = t.text.indexOf(':');
    const key = colon > 0 ? t.text.slice(0, colon).toLowerCase() : '';
    if (colon > 0 && (LEGACY_KEYS as readonly string[]).includes(key)) {
      const node = keyTerm(key as LegacyKey, t.text.slice(colon + 1), t.pos, t.pos + colon + 1, true);
      if (!node) continue;
      count(t.pos);
      const g = groups.get(key as LegacyKey);
      if (g) g.push(node); else groups.set(key as LegacyKey, [node]);
      continue;
    }
    count(t.pos);
    const field = !t.quoted && t.text.includes('.') ? canonicalField(t.text) : null;
    rest.push(field ? { type: 'exists', field, pos: t.pos } : { type: 'text', value: t.text, pos: t.pos });
  }
  const items = [...[...groups.values()].map((g): FilterNode => (g.length === 1 ? g[0] : { type: 'or', items: g })), ...rest];
  if (items.length === 0) return { type: 'true' };
  return items.length === 1 ? items[0] : { type: 'and', items };
}

// ---- public parse -------------------------------------------------------------

export function parseFilter(input: string): ParseResult {
  if (input.length > FILTER_MAX_LENGTH) {
    return { ok: false, error: { message: `expression longer than ${FILTER_MAX_LENGTH} characters`, offset: FILTER_MAX_LENGTH } };
  }
  try {
    const tokens = legacyTokens(input);
    if (legacyShape(tokens)) return { ok: true, ast: parseLegacy(tokens), legacy: true };
    return { ok: true, ast: new Parser(lex(input)).parse(), legacy: false };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: { message: e.message, offset: e.offset } };
    throw e;
  }
}

// ---- compiler ----------------------------------------------------------------

type Pred = (c: Ctx) => boolean;

// [lo, hi] inclusive; `rel` = offsets back from now (relative times).
type NumVal = { lo: number; hi: number; rel: boolean };

const SIZE_UNITS: Record<string, number> = { '': 1, b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
const DURATION_UNITS: Record<string, number> = { '': 1, ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function numValue(kind: Kind, field: string, v: FilterValue): NumVal {
  const t = v.text.trim();
  const one = (n: number): NumVal => ({ lo: n, hi: n, rel: false });
  switch (kind) {
    case 'number':
      if (/^\d+$/.test(t) && Number.isSafeInteger(Number(t))) return one(Number(t));
      return fail(`${field} needs a whole number, not '${v.text}'`, v.pos);
    case 'status': {
      if (STATUS_CODE.test(t)) return one(Number(t));
      const cls = STATUS_CLASS.exec(t);
      if (cls) return { lo: Number(cls[1]) * 100, hi: Number(cls[1]) * 100 + 99, rel: false };
      const r = STATUS_RANGE.exec(t);
      if (r) return { lo: Math.min(Number(r[1]), Number(r[2])), hi: Math.max(Number(r[1]), Number(r[2])), rel: false };
      return fail(`status needs a code (404), a class (4xx) or a range (400-499), not '${v.text}'`, v.pos);
    }
    case 'size': {
      const m = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i.exec(t);
      if (m) return one(Math.round(Number(m[1]) * SIZE_UNITS[(m[2] ?? '').toLowerCase()]));
      return fail(`${field} needs a size such as 512, 10kb or 1.5mb, not '${v.text}'`, v.pos);
    }
    case 'duration': {
      const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(t);
      if (m) return one(Number(m[1]) * DURATION_UNITS[(m[2] ?? '').toLowerCase()]);
      return fail(`${field} needs a duration such as 250ms, 2s or 1m, not '${v.text}'`, v.pos);
    }
    case 'time': {
      const rel = /^-(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i.exec(t);
      if (rel) { const n = Number(rel[1]) * DURATION_UNITS[rel[2].toLowerCase()]; return { lo: n, hi: n, rel: true }; }
      if (/^\d+$/.test(t)) return one(Number(t));
      const ms = /^\d{4}-\d{2}-\d{2}/.test(t) ? Date.parse(t) : NaN;
      if (Number.isFinite(ms)) return one(ms);
      return fail(`time needs an ISO time (2026-10-08T10:00:00Z), epoch ms or a relative time (-5m), not '${v.text}'`, v.pos);
    }
    default:
      throw new Error(`not numeric: ${kind}`);
  }
}

// Anchored, case-insensitive glob with `*` (any run) and `?` (one character).
// Segments between stars are placed leftmost-first, which is exact for globs and
// never backtracks: O(text x pattern) at worst.
function compileGlob(pattern: string): (s: string) => boolean {
  const segs = pattern.toLowerCase().split('*');
  const at = (seg: string, s: string, i: number): boolean => {
    for (let k = 0; k < seg.length; k++) if (seg[k] !== '?' && seg[k] !== s[i + k]) return false;
    return true;
  };
  if (segs.length === 1) return (s) => s.length === segs[0].length && at(segs[0], s, 0);
  const first = segs[0];
  const last = segs[segs.length - 1];
  const middle = segs.slice(1, -1).filter((x) => x !== '');
  return (s) => {
    if (s.length < first.length + last.length || !at(first, s, 0)) return false;
    const end = s.length - last.length;
    if (!at(last, s, end)) return false;
    let pos = first.length;
    for (const seg of middle) {
      let found = -1;
      for (let i = pos; i + seg.length <= end; i++) if (at(seg, s, i)) { found = i; break; }
      if (found < 0) return false;
      pos = found + seg.length;
    }
    return true;
  };
}

const NUMERIC: ReadonlySet<Kind> = new Set(['number', 'status', 'size', 'duration', 'time']);
const ORDER_OPS: ReadonlySet<FilterOp> = new Set(['>', '>=', '<', '<=']);

function checkCaps(spec: Spec, field: string, pos: number, caps: FilterCaps): void {
  if (spec.need === 'detail' && !caps.detail) {
    fail(`${field} needs request/response headers, which the Capture list does not load; use the read API's q= for header and mime fields`, pos);
  }
  if (spec.need === 'body' && !caps.body) fail('body is only searchable in the UI search box, not through the read API', pos);
}

function existsPred(spec: Spec): Pred {
  switch (spec.kind) {
    case 'bool': return (c) => spec.get(c) === true;
    case 'strings': return (c) => (spec.get(c) as readonly string[]).length > 0;
    case 'string': return (c) => { const v = spec.get(c); return v != null && v !== ''; };
    default: return (c) => spec.get(c) != null;
  }
}

function cmpPred(n: Extract<FilterNode, { type: 'cmp' }>, caps: FilterCaps): Pred {
  const spec = specOf(n.field);
  checkCaps(spec, n.field, n.pos, caps);
  const { op, field } = n;
  const opName = op === 'in' ? 'in' : `'${op}'`;
  if (spec.kind === 'bool') {
    if (op !== '==' && op !== '!=') return fail(`${field} is true or false: compare it with == or !=, or use it alone`, n.pos);
    const v = n.values[0];
    const t = v.text.toLowerCase();
    if (t !== 'true' && t !== 'false' && t !== '1' && t !== '0') return fail(`${field} compares with true or false, not '${v.text}'`, v.pos);
    const want = (t === 'true' || t === '1') === (op === '==');
    return (c) => (spec.get(c) === true) === want;
  }
  if (NUMERIC.has(spec.kind)) {
    if (op === 'contains' || op === 'matches') return fail(`${opName} needs a text field; ${field} is a number`, n.pos);
    const vals = n.values.map((v) => numValue(spec.kind, field, v));
    if (ORDER_OPS.has(op) && vals[0].lo !== vals[0].hi) return fail(`${opName} needs a single status code, not a class or range`, n.values[0].pos);
    const resolve = (c: Ctx, v: NumVal): [number, number] => (v.rel ? [c.now() - v.hi, c.now() - v.lo] : [v.lo, v.hi]);
    const test = (c: Ctx, x: number): boolean => {
      switch (op) {
        case '>': return x > resolve(c, vals[0])[0];
        case '>=': return x >= resolve(c, vals[0])[0];
        case '<': return x < resolve(c, vals[0])[0];
        case '<=': return x <= resolve(c, vals[0])[0];
        default: return vals.some((v) => { const [lo, hi] = resolve(c, v); return x >= lo && x <= hi; });
      }
    };
    const get = spec.get;
    const pred: Pred = (c) => { const x = get(c); return typeof x === 'number' && test(c, x); };
    return op === '!=' ? (c) => !pred(c) : pred;
  }
  // Text fields: every comparison is case-insensitive.
  if (ORDER_OPS.has(op)) return fail(`${opName} compares numbers; ${field} is text`, n.pos);
  let test: (s: string) => boolean;
  if (op === 'in') {
    const set = new Set(n.values.map((v) => v.text.toLowerCase()));
    test = (s) => set.has(s);
  } else {
    const want = n.values[0].text.toLowerCase();
    test = op === 'contains' ? (s) => s.includes(want) : op === 'matches' ? compileGlob(want) : (s) => s === want;
  }
  const get = spec.get;
  const pred: Pred = (c) => {
    const v = get(c);
    if (v == null) return false;
    if (typeof v === 'string') return test(v.toLowerCase());
    return (v as readonly string[]).some((s) => test(s.toLowerCase()));
  };
  return op === '!=' ? (c) => !pred(c) : pred;
}

function compileNode(n: FilterNode, caps: FilterCaps): Pred {
  switch (n.type) {
    case 'true': return () => true;
    case 'and': {
      const ps = n.items.map((x) => compileNode(x, caps));
      return (c) => { for (const p of ps) if (!p(c)) return false; return true; };
    }
    case 'or': {
      const ps = n.items.map((x) => compileNode(x, caps));
      return (c) => { for (const p of ps) if (p(c)) return true; return false; };
    }
    case 'not': { const p = compileNode(n.item, caps); return (c) => !p(c); }
    case 'text': { const v = n.value.toLowerCase(); return (c) => c.hay().includes(v); }
    case 'exists': {
      const spec = specOf(n.field);
      checkCaps(spec, n.field, n.pos, caps);
      return existsPred(spec);
    }
    case 'cmp': return cmpPred(n, caps);
  }
}

export function compileFilter(ast: FilterNode, caps: FilterCaps = API_FILTER_CAPS): CompileResult {
  try {
    const p = compileNode(ast, caps);
    return { ok: true, match: (e, env) => p(new Ctx(e, env)) };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: { message: e.message, offset: e.offset } };
    throw e;
  }
}

// Parse + compile in one step. An empty (or whitespace-only) input yields a null
// predicate: there is nothing to filter.
export function buildFilter(input: string, caps: FilterCaps): BuildResult {
  const parsed = parseFilter(input);
  if (!parsed.ok) return parsed;
  if (parsed.ast.type === 'true') return { ok: true, match: null, legacy: parsed.legacy };
  const compiled = compileFilter(parsed.ast, caps);
  return compiled.ok ? { ok: true, match: compiled.match, legacy: parsed.legacy } : compiled;
}

// AND several nodes (the read API folds its simple filters in with `q`).
export function andNodes(nodes: FilterNode[]): FilterNode {
  const items = nodes.filter((x) => x.type !== 'true');
  if (items.length === 0) return { type: 'true' };
  return items.length === 1 ? items[0] : { type: 'and', items };
}
