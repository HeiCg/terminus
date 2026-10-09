// Interception rules for the proxy source (U6): the rule model, its validation and
// the request matcher. PURE: no Node or DOM import, so the UI's rule form runs the
// exact same validation (through ui/src/lib/ruleModel.ts) as `PUT /api/rules`.
// Applying a rule to live traffic is the proxy's job (proxy/rules.ts); persisting
// the list is rulesStore.ts.
//
// A rule is { id, name, enabled, match, phase, action }. `match` tests the request
// AS THE DEVICE SENT IT (before any rewrite), for both phases. Rules run in list
// order: per phase, the first matching enabled `block`/`mock` short-circuits (the
// request never reaches upstream), while `rewrite` and `delay` accumulate in order.

import { isMetadataHost } from './netAddr.js';

export type RulePhase = 'request' | 'response';
export type RuleActionType = 'block' | 'mock' | 'rewrite' | 'delay';

export type RuleMatch = {
  // Upper-cased method tokens; absent = any method.
  methods?: string[];
  // `api.example.com` exactly, or `*.example.com` (any subdomain, not the apex).
  host?: string;
  // A glob over the URL path (no query): `*` any run of characters, `?` one.
  path?: string;
  // Each named query parameter must be present with a value matching its glob.
  query?: Record<string, string>;
  // Each named request header (lower-cased) must be present with a value
  // matching its glob (repeated headers: any value).
  headers?: Record<string, string>;
  scheme?: 'http' | 'https';
};

export type ReplaceItem = { find: string; with: string };

export type BlockAction =
  | { type: 'block'; status?: number; body?: string }
  | { type: 'block'; close: true }
  | { type: 'block'; reset: true };
export type MockAction = {
  type: 'mock'; status: number; headers?: Record<string, string>;
  body?: string; bodyBase64?: string; delayMs?: number;
};
export type RewriteAction = {
  type: 'rewrite';
  // Request phase only.
  url?: string; method?: string;
  // Response phase only.
  status?: number;
  setHeaders?: Record<string, string>; removeHeaders?: string[];
  body?: string; bodyBase64?: string;
  replace?: ReplaceItem[];
};
export type DelayAction = { type: 'delay'; ms: number };
export type RuleAction = BlockAction | MockAction | RewriteAction | DelayAction;

export type Rule = {
  id: string; name: string; enabled: boolean;
  match: RuleMatch; phase: RulePhase; action: RuleAction;
};

// What an entry records about a rule that ran on it. `note` explains a partial
// application (a `replace` stopped at its output cap).
export type AppliedRule = { id: string; name: string; action: RuleActionType; phase: RulePhase; note?: string };

export const RULES_MAX = 200;
export const RULE_BODY_MAX = 1024 * 1024;
export const RULE_REPLACE_MAX = 50;
// One `replace` item's `with` text, in UTF-8 bytes (`find` may be up to
// RULE_BODY_MAX). Small, because every occurrence of `find` repeats it; the
// proxy also caps the replaced body (proxy/rules.ts, RULE_REPLACE_OUTPUT_EXTRA).
export const RULE_REPLACE_WITH_MAX = 64 * 1024;
export const RULE_DELAY_MAX_MS = 30_000;
export const RULE_NAME_MAX = 120;
export const RULE_MAP_MAX = 50; // query/headers matchers, set/remove header lists
export const RULE_HEADER_VALUE_MAX = 8 * 1024;
export const RULE_PATTERN_MAX = 2048;
export const RULE_URL_MAX = 8 * 1024;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
// Framing and connection headers the proxy computes itself: a rule may neither set
// nor remove them (a wrong content-length would corrupt the exchange).
export const RULE_RESERVED_HEADERS: readonly string[] = ['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-connection'];

export type RuleValidation<T> = { ok: true; value: T } | { ok: false; path: string; message: string };

class Invalid extends Error {
  constructor(readonly path: string, message: string) { super(message); }
}
const bad = (path: string, message: string): never => { throw new Invalid(path, message); };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(path ? `${path}.${k}` : k, `unknown field "${k}"`);
}

function str(v: unknown, path: string, opts: { min?: number; max: number; trim?: boolean }): string {
  if (typeof v !== 'string') return bad(path, 'must be a string');
  const s = opts.trim ? v.trim() : v;
  if (s.length < (opts.min ?? 0)) return bad(path, opts.min === 1 ? 'must not be empty' : `must be at least ${opts.min} characters`);
  if (s.length > opts.max) return bad(path, `must be at most ${opts.max} characters`);
  return s;
}

function int(v: unknown, path: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) return bad(path, `must be an integer from ${lo} to ${hi}`);
  return v;
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function bodyText(v: unknown, path: string): string {
  if (typeof v !== 'string') return bad(path, 'must be a string');
  if (utf8Length(v) > RULE_BODY_MAX) return bad(path, `is larger than ${RULE_BODY_MAX} bytes`);
  return v;
}

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
function bodyB64(v: unknown, path: string): string {
  if (typeof v !== 'string') return bad(path, 'must be a base64 string');
  const s = v.replace(/\s+/g, '');
  if (s.length % 4 !== 0 || !B64_RE.test(s)) return bad(path, 'is not valid base64');
  const bytes = (s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
  if (bytes > RULE_BODY_MAX) return bad(path, `decodes to more than ${RULE_BODY_MAX} bytes`);
  return s;
}

function headerName(v: string, path: string, reservedCheck: boolean): string {
  if (v === '' || !TOKEN_RE.test(v)) bad(path, `"${v}" is not a valid header name`);
  const n = v.toLowerCase();
  if (reservedCheck && RULE_RESERVED_HEADERS.includes(n)) bad(path, `"${n}" is managed by the proxy and cannot be changed by a rule`);
  return n;
}

function headerValue(v: unknown, path: string): string {
  const s = str(v, path, { max: RULE_HEADER_VALUE_MAX });
  if (/[\r\n\0]/.test(s)) bad(path, 'must not contain CR, LF or NUL');
  return s;
}

function headerMap(v: unknown, path: string, reservedCheck: boolean): Record<string, string> {
  if (!isObj(v)) return bad(path, 'must be an object of header name to value');
  const entries = Object.entries(v);
  if (entries.length > RULE_MAP_MAX) bad(path, `has more than ${RULE_MAP_MAX} headers`);
  const out: Record<string, string> = {};
  for (const [k, val] of entries) {
    const n = headerName(k, `${path}.${k}`, reservedCheck);
    if (Object.hasOwn(out, n)) bad(`${path}.${k}`, `header "${n}" is listed twice`);
    out[n] = headerValue(val, `${path}.${k}`);
  }
  return out;
}

function method(v: unknown, path: string): string {
  const s = str(v, path, { min: 1, max: 32 });
  if (!TOKEN_RE.test(s)) bad(path, `"${s}" is not a valid HTTP method`);
  return s.toUpperCase();
}

// `api.example.com` or `*.example.com`; no scheme, port or path. IPv4 literals are
// exact hosts. Returned lower-cased.
export function parseRuleHost(input: string): { ok: true; host: string; wildcard: boolean } | { ok: false; message: string } {
  const raw = input.trim().toLowerCase();
  if (raw === '') return { ok: false, message: 'must not be empty' };
  if (raw.includes('://')) return { ok: false, message: 'a scheme is not allowed (use the bare host; see match.scheme)' };
  if (raw.includes('/')) return { ok: false, message: 'a path is not allowed here (see match.path)' };
  if (raw.includes(':') || raw.includes('[')) return { ok: false, message: 'a port or IPv6 literal is not allowed' };
  const wildcard = raw.startsWith('*.');
  const host = (wildcard ? raw.slice(2) : raw).replace(/\.$/, '');
  if (host === '' || host.includes('*')) return { ok: false, message: 'the only host wildcard is a leading "*."' };
  if (host.length > 253 || !host.split('.').every((l) => LABEL.test(l))) return { ok: false, message: 'not a valid hostname' };
  return { ok: true, host, wildcard };
}

function glob(v: unknown, path: string): string {
  return str(v, path, { max: RULE_PATTERN_MAX });
}

function validateMatch(v: unknown, path: string): RuleMatch {
  if (!isObj(v)) return bad(path, 'must be an object (use {} to match every request)');
  onlyKeys(v, ['methods', 'host', 'path', 'query', 'headers', 'scheme'], path);
  const out: RuleMatch = {};
  if (v.methods !== undefined) {
    if (!Array.isArray(v.methods)) bad(`${path}.methods`, 'must be an array of HTTP methods');
    const ms = v.methods as unknown[];
    if (ms.length === 0) bad(`${path}.methods`, 'must not be empty (omit it to match any method)');
    if (ms.length > 20) bad(`${path}.methods`, 'has more than 20 methods');
    out.methods = [...new Set(ms.map((m, i) => method(m, `${path}.methods[${i}]`)))];
  }
  if (v.host !== undefined) {
    if (typeof v.host !== 'string') bad(`${path}.host`, 'must be a string');
    const h = parseRuleHost(v.host as string);
    if (!h.ok) return bad(`${path}.host`, h.message);
    out.host = h.wildcard ? `*.${h.host}` : h.host;
  }
  if (v.path !== undefined) {
    const p = glob(v.path, `${path}.path`);
    if (!p.startsWith('/') && !p.startsWith('*')) bad(`${path}.path`, 'must start with "/" (or a "*" glob)');
    out.path = p;
  }
  if (v.query !== undefined) {
    if (!isObj(v.query)) bad(`${path}.query`, 'must be an object of parameter name to glob');
    const q = Object.entries(v.query as Record<string, unknown>);
    if (q.length > RULE_MAP_MAX) bad(`${path}.query`, `has more than ${RULE_MAP_MAX} parameters`);
    out.query = {};
    for (const [k, g] of q) {
      if (k === '' || k.length > 256) bad(`${path}.query`, 'parameter names must be 1-256 characters');
      out.query[k] = glob(g, `${path}.query.${k}`);
    }
  }
  if (v.headers !== undefined) {
    if (!isObj(v.headers)) bad(`${path}.headers`, 'must be an object of header name to glob');
    const hs = Object.entries(v.headers as Record<string, unknown>);
    if (hs.length > RULE_MAP_MAX) bad(`${path}.headers`, `has more than ${RULE_MAP_MAX} headers`);
    out.headers = {};
    for (const [k, g] of hs) out.headers[headerName(k, `${path}.headers.${k}`, false)] = glob(g, `${path}.headers.${k}`);
  }
  if (v.scheme !== undefined) {
    if (v.scheme !== 'http' && v.scheme !== 'https') bad(`${path}.scheme`, 'must be "http" or "https"');
    out.scheme = v.scheme as 'http' | 'https';
  }
  return out;
}

function validateBody(a: Record<string, unknown>, path: string, out: { body?: string; bodyBase64?: string }): void {
  if (a.body !== undefined && a.bodyBase64 !== undefined) bad(`${path}.bodyBase64`, 'set either body or bodyBase64, not both');
  if (a.body !== undefined) out.body = bodyText(a.body, `${path}.body`);
  if (a.bodyBase64 !== undefined) out.bodyBase64 = bodyB64(a.bodyBase64, `${path}.bodyBase64`);
}

function validateRewriteUrl(v: unknown, path: string): string {
  const s = str(v, path, { min: 1, max: RULE_URL_MAX });
  if (/\s/.test(s)) bad(path, 'must not contain whitespace');
  if (s.startsWith('/')) {
    if (s.startsWith('//')) bad(path, 'a path replacement must not start with "//"');
    return s;
  }
  let u: URL;
  try { u = new URL(s); } catch { return bad(path, 'must be an absolute http(s) URL or a path starting with "/"'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') bad(path, 'must be an http or https URL');
  if (u.username || u.password) bad(path, 'must not carry credentials');
  // Never a rewrite target: the cloud metadata service in any spelling (the proxy
  // refuses it too).
  if (isMetadataHost(u.hostname)) bad(path, 'the cloud metadata address is never a rewrite target');
  return s;
}

function validateAction(v: unknown, phase: RulePhase, path: string): RuleAction {
  if (!isObj(v)) return bad(path, 'must be an object with a "type"');
  const type = v.type;
  if (type !== 'block' && type !== 'mock' && type !== 'rewrite' && type !== 'delay') return bad(`${path}.type`, 'must be "block", "mock", "rewrite" or "delay"');
  if (phase === 'response' && (type === 'block' || type === 'mock')) return bad(`${path}.type`, `"${type}" is a request-phase action (the response phase allows rewrite and delay)`);
  switch (type) {
    case 'delay': {
      onlyKeys(v, ['type', 'ms'], path);
      return { type, ms: int(v.ms, `${path}.ms`, 1, RULE_DELAY_MAX_MS) };
    }
    case 'block': {
      onlyKeys(v, ['type', 'status', 'body', 'close', 'reset'], path);
      if (v.close !== undefined || v.reset !== undefined) {
        const which = v.close !== undefined ? 'close' : 'reset';
        if (v.close !== undefined && v.reset !== undefined) bad(`${path}.reset`, 'set either close or reset, not both');
        if (v[which] !== true) bad(`${path}.${which}`, 'must be true');
        if (v.status !== undefined || v.body !== undefined) bad(`${path}.${which}`, `${which} drops the connection: it takes no status or body`);
        return which === 'close' ? { type, close: true } : { type, reset: true };
      }
      const out: { type: 'block'; status?: number; body?: string } = { type };
      if (v.status !== undefined) out.status = int(v.status, `${path}.status`, 200, 599);
      if (v.body !== undefined) out.body = bodyText(v.body, `${path}.body`);
      return out;
    }
    case 'mock': {
      onlyKeys(v, ['type', 'status', 'headers', 'body', 'bodyBase64', 'delayMs'], path);
      const out: MockAction = { type, status: int(v.status, `${path}.status`, 200, 599) };
      if (v.headers !== undefined) out.headers = headerMap(v.headers, `${path}.headers`, true);
      validateBody(v, path, out);
      if (v.delayMs !== undefined) out.delayMs = int(v.delayMs, `${path}.delayMs`, 0, RULE_DELAY_MAX_MS);
      return out;
    }
    case 'rewrite': {
      onlyKeys(v, ['type', 'url', 'method', 'status', 'setHeaders', 'removeHeaders', 'body', 'bodyBase64', 'replace'], path);
      const out: RewriteAction = { type };
      if (phase === 'response') {
        if (v.url !== undefined) bad(`${path}.url`, 'only a request-phase rewrite can change the URL');
        if (v.method !== undefined) bad(`${path}.method`, 'only a request-phase rewrite can change the method');
        if (v.status !== undefined) out.status = int(v.status, `${path}.status`, 200, 599);
      } else {
        if (v.status !== undefined) bad(`${path}.status`, 'only a response-phase rewrite can change the status (use mock or block)');
        if (v.url !== undefined) out.url = validateRewriteUrl(v.url, `${path}.url`);
        if (v.method !== undefined) out.method = method(v.method, `${path}.method`);
      }
      if (v.setHeaders !== undefined) out.setHeaders = headerMap(v.setHeaders, `${path}.setHeaders`, true);
      if (v.removeHeaders !== undefined) {
        if (!Array.isArray(v.removeHeaders)) bad(`${path}.removeHeaders`, 'must be an array of header names');
        const rs = v.removeHeaders as unknown[];
        if (rs.length > RULE_MAP_MAX) bad(`${path}.removeHeaders`, `has more than ${RULE_MAP_MAX} headers`);
        out.removeHeaders = [...new Set(rs.map((n, i) => {
          if (typeof n !== 'string') return bad(`${path}.removeHeaders[${i}]`, 'must be a string');
          return headerName(n, `${path}.removeHeaders[${i}]`, true);
        }))];
      }
      validateBody(v, path, out);
      if (v.replace !== undefined) {
        if (!Array.isArray(v.replace)) bad(`${path}.replace`, 'must be an array of {"find", "with"}');
        const items = v.replace as unknown[];
        if (items.length > RULE_REPLACE_MAX) bad(`${path}.replace`, `has more than ${RULE_REPLACE_MAX} items`);
        out.replace = items.map((it, i) => {
          const p = `${path}.replace[${i}]`;
          if (!isObj(it)) return bad(p, 'must be an object {"find", "with"}');
          onlyKeys(it, ['find', 'with'], p);
          const find = bodyText(it.find, `${p}.find`);
          if (find === '') bad(`${p}.find`, 'must not be empty');
          const w = bodyText(it.with ?? '', `${p}.with`);
          if (utf8Length(w) > RULE_REPLACE_WITH_MAX) bad(`${p}.with`, `is larger than ${RULE_REPLACE_WITH_MAX} bytes`);
          return { find, with: w };
        });
      }
      const changes = ['url', 'method', 'status', 'setHeaders', 'removeHeaders', 'body', 'bodyBase64', 'replace'].filter((k) => (out as Record<string, unknown>)[k] !== undefined);
      if (changes.length === 0) bad(path, 'a rewrite must change something');
      return out;
    }
  }
}

// One rule. `id` is optional here: a caller that wants ids assigned passes
// `assignId`; otherwise a missing id is an error.
export function validateRule(v: unknown, path = 'rule', assignId?: () => string): RuleValidation<Rule> {
  try { return { ok: true, value: checkRule(v, path, assignId) }; } catch (e) {
    if (e instanceof Invalid) return { ok: false, path: e.path, message: e.message };
    throw e;
  }
}

function checkRule(v: unknown, path: string, assignId?: () => string): Rule {
  if (!isObj(v)) return bad(path, 'must be an object');
  onlyKeys(v, ['id', 'name', 'enabled', 'match', 'phase', 'action'], path);
  let id: string;
  if (v.id === undefined && assignId) id = assignId();
  else {
    id = str(v.id, `${path}.id`, { min: 1, max: 64 });
    if (!ID_RE.test(id)) bad(`${path}.id`, 'must be 1-64 characters of A-Z a-z 0-9 . _ -');
  }
  const name = str(v.name, `${path}.name`, { min: 1, max: RULE_NAME_MAX, trim: true });
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') bad(`${path}.enabled`, 'must be true or false');
  if (v.phase !== 'request' && v.phase !== 'response') return bad(`${path}.phase`, 'must be "request" or "response"');
  const phase = v.phase;
  const match = validateMatch(v.match ?? {}, `${path}.match`);
  const action = validateAction(v.action, phase, `${path}.action`);
  return { id, name, enabled: v.enabled !== false, match, phase, action };
}

// The `PUT /api/rules` body: `{ "rules": [...] }`, validated whole. The first
// error is reported with its path (`rules[2].action.status`).
export function validateRulesBody(body: unknown, assignId?: () => string): RuleValidation<Rule[]> {
  try {
    if (!isObj(body)) bad('', 'body must be an object {"rules": [...]}');
    const b = body as Record<string, unknown>;
    onlyKeys(b, ['rules'], '');
    if (!Array.isArray(b.rules)) bad('rules', 'must be an array');
    const list = b.rules as unknown[];
    if (list.length > RULES_MAX) bad('rules', `has more than ${RULES_MAX} rules`);
    const seen = new Set<string>();
    const rules = list.map((r, i) => {
      const rule = checkRule(r, `rules[${i}]`, assignId);
      if (seen.has(rule.id)) bad(`rules[${i}].id`, `duplicate id "${rule.id}"`);
      seen.add(rule.id);
      return rule;
    });
    return { ok: true, value: rules };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, path: e.path, message: e.message };
    throw e;
  }
}

export const formatRuleError = (e: { path: string; message: string }): string => (e.path ? `${e.path}: ${e.message}` : e.message);

// ---- matching ----------------------------------------------------------------

// `*` matches any run of characters (slashes included), `?` exactly one; every
// other character is literal and case-sensitive. Iterative with a single
// backtrack point: O(text x pattern) worst case, no regex built from input.
export function globMatch(pattern: string, text: string): boolean {
  let p = 0; let t = 0; let star = -1; let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) { p++; t++; }
    else if (p < pattern.length && pattern[p] === '*') { star = p++; mark = t; }
    else if (star >= 0) { p = star + 1; t = ++mark; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

export function ruleHostMatches(pattern: string, hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return pattern.startsWith('*.') ? h.endsWith(pattern.slice(1)) : h === pattern;
}

// The request a rule is matched against: the device's request as it arrived.
export type RuleRequest = { method: string; url: string; headers: Record<string, string | string[] | undefined> };

export function ruleMatches(m: RuleMatch, req: RuleRequest): boolean {
  if (m.methods && !m.methods.includes(req.method.toUpperCase())) return false;
  let u: URL;
  try { u = new URL(req.url); } catch { return false; }
  if (m.scheme && u.protocol !== `${m.scheme}:`) return false;
  if (m.host && !ruleHostMatches(m.host, u.hostname)) return false;
  if (m.path !== undefined && !globMatch(m.path, u.pathname)) return false;
  if (m.query) {
    for (const [name, g] of Object.entries(m.query)) {
      if (!u.searchParams.getAll(name).some((v) => globMatch(g, v))) return false;
    }
  }
  if (m.headers) {
    for (const [name, g] of Object.entries(m.headers)) {
      const raw = req.headers[name];
      const vals = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
      if (!vals.some((v) => globMatch(g, v))) return false;
    }
  }
  return true;
}
