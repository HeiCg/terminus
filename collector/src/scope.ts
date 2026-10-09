import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

// Host patterns (U5), shared by the capture scope (TERMINUS_SCOPE_INCLUDE/EXCLUDE,
// `PUT /api/scope`) and the proxy's TLS pass-through lists. One grammar for both:
//
//   api.example.com            exactly this host
//   *.example.com              any subdomain at any depth (not example.com itself)
//   api.example.com/v1/*       this host, path starting with /v1/   (scope only)
//   api.example.com/health     this host, exactly this path         (scope only)
//
// Hosts compare case-insensitively and never carry a scheme or a port. The only
// wildcard is a leading `*.` label (and a trailing `*` on a path). An IPv4 literal
// is a valid exact host; IPv6 literals are not supported.
export type HostPattern = {
  raw: string;
  // `*.example.com` keeps `example.com` here with `wildcard: true`.
  host: string; wildcard: boolean;
  // Absent: any path. `prefix: true` came from a trailing `*`.
  path: string | null; prefix: boolean;
};

export type PatternError = { raw: string; message: string };

const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const MAX_PATTERN = 1024;

export function parseHostPattern(input: string, opts: { allowPath: boolean }): { ok: true; pattern: HostPattern } | { ok: false; message: string } {
  const raw = input.trim();
  if (raw === '') return { ok: false, message: 'empty pattern' };
  if (raw.length > MAX_PATTERN) return { ok: false, message: `longer than ${MAX_PATTERN} characters` };
  if (/\s/.test(raw)) return { ok: false, message: 'contains whitespace' };
  if (raw.includes('://')) return { ok: false, message: 'a scheme is not allowed (use the bare host)' };
  const slash = raw.indexOf('/');
  const hostPart = (slash < 0 ? raw : raw.slice(0, slash)).toLowerCase();
  const pathPart = slash < 0 ? null : raw.slice(slash);
  if (hostPart.includes(':') || hostPart.includes('[')) return { ok: false, message: 'a port or IPv6 literal is not allowed' };
  const wildcard = hostPart.startsWith('*.');
  const host = (wildcard ? hostPart.slice(2) : hostPart).replace(/\.$/, '');
  if (host === '' || host.includes('*')) return { ok: false, message: 'the only host wildcard is a leading "*."' };
  if (host.length > 253 || !host.split('.').every((l) => LABEL.test(l))) return { ok: false, message: 'not a valid hostname' };
  if (pathPart == null) return { ok: true, pattern: { raw, host, wildcard, path: null, prefix: false } };
  if (!opts.allowPath) return { ok: false, message: 'a path is not allowed here (host only)' };
  const prefix = pathPart.endsWith('*');
  const p = prefix ? pathPart.slice(0, -1) : pathPart;
  if (p.includes('*')) return { ok: false, message: 'the only path wildcard is a trailing "*"' };
  return { ok: true, pattern: { raw, host, wildcard, path: p, prefix } };
}

// Parse a comma list (env) or an array (API). Invalid items are returned
// separately so the caller decides: the env reader warns and skips, the API
// refuses the whole update.
export function parsePatternList(input: string | readonly string[] | undefined, opts: { allowPath: boolean }): { patterns: HostPattern[]; invalid: PatternError[] } {
  const items = input == null ? [] : typeof input === 'string' ? input.split(',') : [...input];
  const patterns: HostPattern[] = [];
  const invalid: PatternError[] = [];
  for (const item of items) {
    if (item.trim() === '') continue;
    const r = parseHostPattern(item, opts);
    if (r.ok) patterns.push(r.pattern);
    else invalid.push({ raw: item.trim(), message: r.message });
  }
  return { patterns, invalid };
}

export function hostMatches(p: HostPattern, hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return p.wildcard ? h.endsWith('.' + p.host) : h === p.host;
}

// Percent-decoding that never throws: each run of %XX escapes is decoded as UTF-8;
// a run that is not valid UTF-8 keeps its bytes >= 0x80 escaped (only the ASCII
// ones are decoded), and a `%` not followed by two hex digits stays as it is.
export function decodePathSafe(p: string): string {
  return p.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try { return decodeURIComponent(run); } catch {
      return run.replace(/%([0-7][0-9a-fA-F])/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    }
  });
}

// RFC 3986 remove_dot_segments over an absolute path.
function removeDotSegments(p: string): string {
  const out: string[] = [];
  const segs = p.split('/');
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    const last = i === segs.length - 1;
    if (s === '.' || s === '..') {
      if (s === '..' && out.length) out.pop();
      if (last) out.push('');
      continue;
    }
    out.push(s);
  }
  return '/' + out.join('/');
}

// The path a scope pattern is matched against: percent-decoded (once, safely),
// then with `.`/`..` segments resolved, so `/%61dmin`, `/v1%2F..%2Fadmin` and
// `/admin` are the same path. Matching stays case-sensitive (`/Admin` is not
// `/admin`), as paths are on most servers.
export function scopePath(pathname: string): string {
  // A stream URL (`tcp://host:port`) has no path: keep it empty.
  if (!pathname.startsWith('/')) return pathname;
  return removeDotSegments(decodePathSafe(pathname));
}

export function patternMatches(p: HostPattern, hostname: string, pathname: string): boolean {
  if (!hostMatches(p, hostname)) return false;
  if (p.path == null) return true;
  return p.prefix ? pathname.startsWith(p.path) : pathname === p.path;
}

// ---- Capture scope -------------------------------------------------------

// What is recorded. An entry or WebSocket session whose URL matches an exclude
// pattern, or (when `include` is non-empty) matches no include pattern, is not
// stored. Exclude wins over include; an empty include means everything.
export type ScopeConfig = { include: string[]; exclude: string[] };
export type ScopeDropReason = 'excluded' | 'notIncluded';

export const EMPTY_SCOPE: ScopeConfig = { include: [], exclude: [] };

// Upper bounds on an admin-supplied scope, so a PUT cannot grow the per-record
// check without limit.
export const SCOPE_MAX_PATTERNS = 256;

export class CaptureScope {
  private readonly include: HostPattern[];
  private readonly exclude: HostPattern[];

  constructor(cfg: ScopeConfig = EMPTY_SCOPE) {
    this.include = parsePatternList(cfg.include, { allowPath: true }).patterns;
    this.exclude = parsePatternList(cfg.exclude, { allowPath: true }).patterns;
  }

  get empty(): boolean { return this.include.length === 0 && this.exclude.length === 0; }

  config(): ScopeConfig { return { include: this.include.map((p) => p.raw), exclude: this.exclude.map((p) => p.raw) }; }

  // Why `url` is out of scope, or null when it is recorded. A missing or
  // unparsable URL is recorded: the scope cannot judge what it cannot read
  // (e.g. a WebSocket session synthesized before its handshake URL is known).
  verdict(url: string | null | undefined): ScopeDropReason | null {
    if (this.empty || url == null) return null;
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname;
    const p = scopePath(u.pathname);
    if (this.exclude.some((x) => patternMatches(x, host, p))) return 'excluded';
    if (this.include.length > 0 && !this.include.some((x) => patternMatches(x, host, p))) return 'notIncluded';
    return null;
  }
}

// Strict validation for `PUT /api/scope`: the whole body is refused when any
// pattern is invalid, so the admin never gets a silently partial scope.
export function validateScopeBody(body: unknown): { ok: true; value: ScopeConfig } | { ok: false; message: string; invalid?: PatternError[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, message: 'body must be an object {"include": [...], "exclude": [...]}' };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'include' && k !== 'exclude') return { ok: false, message: `unknown field "${k}"` };
  const lists: Partial<ScopeConfig> = {};
  const invalid: PatternError[] = [];
  for (const k of ['include', 'exclude'] as const) {
    const v = b[k] ?? [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return { ok: false, message: `${k} must be an array of strings` };
    if (v.length > SCOPE_MAX_PATTERNS) return { ok: false, message: `${k} has more than ${SCOPE_MAX_PATTERNS} patterns` };
    const r = parsePatternList(v as string[], { allowPath: true });
    invalid.push(...r.invalid);
    lists[k] = r.patterns.map((p) => p.raw);
  }
  if (invalid.length) return { ok: false, message: `invalid pattern: ${invalid.map((i) => `"${i.raw}" (${i.message})`).join(', ')}`, invalid };
  return { ok: true, value: { include: lists.include ?? [], exclude: lists.exclude ?? [] } };
}

// Lenient reader for the env variables: invalid items are logged and skipped.
export function scopeFromEnv(include: string | undefined, exclude: string | undefined, names = { include: 'TERMINUS_SCOPE_INCLUDE', exclude: 'TERMINUS_SCOPE_EXCLUDE' }): ScopeConfig {
  const out: ScopeConfig = { include: [], exclude: [] };
  for (const k of ['include', 'exclude'] as const) {
    const r = parsePatternList(k === 'include' ? include : exclude, { allowPath: true });
    for (const i of r.invalid) log.warn(`${names[k]}: ignoring invalid pattern "${i.raw}": ${i.message}`);
    out[k] = r.patterns.map((p) => p.raw);
  }
  return out;
}

// ---- Persistence (<stateDir>/scope.json) --------------------------------

export const SCOPE_FILE = 'scope.json';

// The persisted scope, or null when the file is absent. A malformed file is
// logged and treated as absent (the env value applies) rather than failing boot.
export function loadScopeFile(file: string): ScopeConfig | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const r = validateScopeBody(JSON.parse(text));
    if (r.ok) return r.value;
    log.warn(`${file}: ignoring persisted scope (${r.message})`);
  } catch (e) {
    log.warn(`${file}: ignoring unreadable scope file`, String(e));
  }
  return null;
}

// Atomic, owner-only write: a temp file in the same directory, then rename.
export function saveScopeFile(file: string, cfg: ScopeConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
