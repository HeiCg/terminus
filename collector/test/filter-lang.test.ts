import { describe, it, expect } from 'vitest';
import {
  parseFilter, compileFilter, buildFilter, formatFilterError, canonicalField,
  API_FILTER_CAPS, UI_FILTER_CAPS, FILTER_MAX_LENGTH, FILTER_MAX_DEPTH, FILTER_MAX_NODES,
  type FilterNode, type FilterSubject, type MatchEnv, type FilterCaps, type FilterHeaders,
} from '../src/filterLang.js';
import type { BodyRef } from '../src/types.js';

// U2: the shared filter language. Parser shape (precedence, every operator),
// errors with offsets, limits, and predicates over fixture summaries.

// A compact rendering of an AST, so precedence tables read like the grammar.
function show(n: FilterNode): string {
  switch (n.type) {
    case 'true': return 'true';
    case 'and': case 'or': return `(${n.type} ${n.items.map(show).join(' ')})`;
    case 'not': return `(not ${show(n.item)})`;
    case 'text': return `text:${JSON.stringify(n.value)}`;
    case 'exists': return `?${n.field}`;
    case 'cmp': return n.op === 'in' ? `${n.field} in {${n.values.map((v) => v.text).join(',')}}` : `${n.field} ${n.op} ${n.values[0].text}`;
  }
}
const ast = (q: string): string => {
  const r = parseFilter(q);
  if (!r.ok) throw new Error(`${q}: ${formatFilterError(r.error)}`);
  return show(r.ast);
};

describe('parseFilter: shapes and precedence', () => {
  const CASES: [string, string][] = [
    ['', 'true'],
    ['   ', 'true'],
    ['status >= 500', 'status >= 500'],
    ['status>=500', 'status >= 500'],
    ['method == GET', 'method == GET'],
    ['method != GET', 'method != GET'],
    ['duration > 2s', 'duration > 2s'],
    ['duration < 250ms', 'duration < 250ms'],
    ['size.res <= 10kb', 'size.res <= 10kb'],
    ['url contains /v1/', 'url contains /v1/'],
    ['url ~ /v1/', 'url contains /v1/'],
    ['path matches "/v?/*"', 'path matches /v?/*'],
    ['method in {GET, POST}', 'method in {GET,POST}'],
    ['status in {2xx,404}', 'status in {2xx,404}'],
    ['METHOD == get', 'method == get'],
    // Bare fields are existence tests; bare non-fields are text searches.
    ['(error)', '?error'],
    ['not error', '(not ?error)'],
    ['!completed', '(not ?completed)'],
    ['redacted.request', '?redacted.request'],
    ['http.response', '?http.response'],
    ['header.Authorization', '?header.authorization'],
    ['req.header.x-trace && res.header.etag', '(and ?req.header.x-trace ?res.header.etag)'],
    // Precedence: not > and > or; juxtaposition is AND.
    ['a or b and c', '(or text:"a" (and text:"b" text:"c"))'],
    ['a and b or c', '(or (and text:"a" text:"b") text:"c")'],
    ['not a and b', '(and (not text:"a") text:"b")'],
    ['not (a or b)', '(not (or text:"a" text:"b"))'],
    ['!(a || b) && c', '(and (not (or text:"a" text:"b")) text:"c")'],
    ['a b or c', '(or (and text:"a" text:"b") text:"c")'],
    ['a || b || c', '(or text:"a" text:"b" text:"c")'],
    ['a AND b OR NOT c', '(or (and text:"a" text:"b") (not text:"c"))'],
    ['((status == 200))', 'status == 200'],
    ['not not completed', '(not (not ?completed))'],
    // key:value terms inside an expression: one term each, juxtaposition ANDs.
    ['status >= 500 host:api', '(and status >= 500 host contains api)'],
    ['host:"api v2" or method:get,post', '(or host contains api v2 method in {get,post})'],
    ['(device:ph body:tok)', '(and device.id contains ph body contains tok)'],
    // Quoted strings: a text search, escapes resolved.
    ['"two words" and status == 200', '(and text:"two words" status == 200)'],
    ['url contains "a\\"b\\\\c\\n"', 'url contains a"b\\c\n'],
    ['time > -5m', 'time > -5m'],
    ['time >= 2026-10-08T10:00:00Z', 'time >= 2026-10-08T10:00:00Z'],
  ];
  it.each(CASES)('%s', (q, want) => {
    expect(ast(q)).toBe(want);
  });

  it('marks the 0.2 reading only for inputs without expression syntax', () => {
    expect(parseFilter('method:get api').ok && (parseFilter('method:get api') as { legacy: boolean }).legacy).toBe(true);
    expect((parseFilter('method == get') as { legacy: boolean }).legacy).toBe(false);
    expect((parseFilter('(error)') as { legacy: boolean }).legacy).toBe(false);
  });
});

describe('parseFilter/buildFilter: errors carry the character offset', () => {
  const CASES: [string, string, number][] = [
    ['status >=', 'expected a value after', 9],
    ['status = 200', "unexpected '='", 7],
    ['(status == 200', "missing ')'", 14],
    ['(a or b', "missing ')'", 7],
    ['foo == 1', "unknown field 'foo'", 0],
    ['a and (b or) c', "unexpected ')'", 11],
    ['a & b', "unexpected '&'", 2],
    ['a | b', "unexpected '|'", 2],
    ['url ~ "abc', 'unterminated string', 6],
    ['url ~ "a\\qb"', "unknown escape '\\q'", 8],
    ['method in GET', "expected '{' after 'in'", 10],
    ['method in {GET POST}', "expected ',' or '}'", 15],
    ['method in {GET,', 'expected a value', 15],
    ['method in {}', 'expected a value', 11],
    ['method in {GET', "missing '}'", 14],
    ['()', "expected an expression inside '( )'", 1],
    ['a )', "unexpected ')'", 2],
    ['a and', 'expected an expression', 5],
    ['not', 'expected an expression', 3],
    ['status == 1 , b', "unexpected ','", 12],
    ['== 200', "unexpected '=='", 0],
    ['status == == 2', 'expected a value', 10],
    ['(host:)', 'host: needs a value', 1],
    ['(method:,)', 'method: needs a value', 1],
    // Compile errors (type mismatches) point at the field or the value.
    ['status == abc', 'status needs a code', 10],
    ['(status:abc)', 'status needs a code', 8],
    ['status > 2xx', 'single status code', 9],
    ['method > 1', 'compares numbers; method is text', 0],
    ['duration contains 5', 'needs a text field', 0],
    ['completed == maybe', 'true or false', 13],
    ['completed > 1', 'compare it with == or !=', 0],
    ['size.res > 10zb', 'size such as', 11],
    ['duration > 2days', 'duration such as', 11],
    ['time > yesterday', 'ISO time', 7],
    ['port == 80.5', 'whole number', 8],
  ];
  it.each(CASES)('%s', (q, msg, offset) => {
    const r = buildFilter(q, API_FILTER_CAPS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain(msg);
    expect(r.error.offset).toBe(offset);
  });

  it('the 0.2 reading never errors (bad status values are ignored)', () => {
    for (const q of ['status:nope', 'host:', 'foo:bar', 'method:,', '"unterminated', 'a,b']) {
      expect(buildFilter(q, UI_FILTER_CAPS).ok).toBe(true);
    }
  });

  it('formats an error with its offset', () => {
    expect(formatFilterError({ message: 'x', offset: 3 })).toBe('x (at offset 3)');
  });
});

describe('limits', () => {
  it(`refuses input longer than ${FILTER_MAX_LENGTH} characters`, () => {
    const r = parseFilter(`url ~ "${'a'.repeat(FILTER_MAX_LENGTH)}"`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.offset).toBe(FILTER_MAX_LENGTH);
    expect(parseFilter(`url ~ "${'a'.repeat(FILTER_MAX_LENGTH - 9)}"`).ok).toBe(true);
  });

  it(`refuses nesting deeper than ${FILTER_MAX_DEPTH}`, () => {
    const deep = (n: number) => `${'('.repeat(n)}a${')'.repeat(n)}`;
    expect(parseFilter(deep(FILTER_MAX_DEPTH - 1)).ok).toBe(true);
    const r = parseFilter(deep(40));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.message).toContain('nested too deeply'); expect(r.error.offset).toBe(FILTER_MAX_DEPTH); }
    const nots = parseFilter(`${'!'.repeat(40)}a`);
    expect(nots.ok).toBe(false);
  });

  it(`refuses more than ${FILTER_MAX_NODES} terms`, () => {
    const many = `(${Array.from({ length: FILTER_MAX_NODES + 10 }, () => 'a').join(' ')})`;
    expect(many.length).toBeLessThanOrEqual(FILTER_MAX_LENGTH);
    const r = parseFilter(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('too large');
    // The 0.2 reading is bounded the same way.
    const legacy = parseFilter(Array.from({ length: FILTER_MAX_NODES + 10 }, () => 'a').join(' '));
    expect(legacy.ok).toBe(false);
  });
});

describe('canonicalField', () => {
  it('knows the static fields and header families, case-insensitively', () => {
    for (const f of ['method', 'url', 'host', 'path', 'query', 'scheme', 'port', 'status', 'source', 'device', 'device.id',
      'duration', 'size.req', 'size.res', 'time', 'seq', 'completed', 'error', 'redacted.request', 'redacted.response',
      'http.response', 'mime.res', 'body', 'header.x-a', 'req.header.cookie', 'res.header.etag']) {
      expect(canonicalField(f.toUpperCase())).toBe(f);
    }
    for (const f of ['foo', 'header.', 'header', 'req.header.', 'size', 'api.example.com']) expect(canonicalField(f)).toBeNull();
  });
});

// ---- predicates over fixtures ---------------------------------------------------

const NOW = Date.parse('2026-10-08T12:00:00Z');
const ref = (size: number | null, state: BodyRef['state'] = size ? 'captured' : 'absent'): BodyRef =>
  ({ state, sha256: size ? `h${size}` : null, size, storedSize: size ?? 0, encoding: 'utf8', omitted: null });

const base = (over: Partial<FilterSubject>): FilterSubject => ({
  id: 'x', deviceId: 'd1', source: 'atlantis', startedAt: NOW - 1000, method: 'GET', url: 'https://api.example.com/',
  status: 200, durationMs: 10, error: null, requestBody: ref(null), responseBody: ref(null),
  redacted: { request: false, response: false }, ...over,
});

const ENTRIES: FilterSubject[] = [
  base({ id: 'e1', url: 'https://api.example.com/v1/users?page=2', durationMs: 120, responseBody: ref(2048), startedAt: NOW - 60_000, seq: 1 }),
  base({ id: 'e2', method: 'POST', url: 'https://api.example.com/v1/login', status: 401, durationMs: 300, source: 'xhr',
    requestBody: ref(64), responseBody: ref(128), redacted: { request: true, response: false }, startedAt: NOW - 600_000, seq: 2 }),
  base({ id: 'e3', url: 'http://cdn.example.net:8080/img/logo.png', status: 304, durationMs: 15, source: 'proxy', deviceId: 'd2', seq: 3 }),
  base({ id: 'e4', method: 'PUT', url: 'https://api.example.com/v2/items/9', status: 500, durationMs: 2500, source: 'replay',
    deviceId: 'd2', responseBody: ref(1572864), seq: 4 }),
  base({ id: 'e5', url: 'https://api.example.com/v1/stream', status: null, durationMs: null, seq: 5 }),
  base({ id: 'e6', method: 'DELETE', url: 'https://other.test/x', status: null, error: 'timeout', durationMs: 30_000, source: 'xhr', deviceId: 'd3', seq: 6 }),
];

const HEADERS: Record<string, FilterHeaders> = {
  e1: { requestHeaders: {}, responseHeaders: { 'content-type': 'application/json' } },
  e2: { requestHeaders: { Authorization: '[REDACTED]' }, responseHeaders: { 'Content-Type': 'application/json; charset=utf-8' } },
  e3: { requestHeaders: {}, responseHeaders: { 'Content-Type': 'image/png' } },
};
const ENV: MatchEnv = {
  now: NOW,
  deviceNames: (id) => (id === 'd1' ? ['com.acme.app', 'ext-1'] : id === 'd2' ? ['alias-2'] : []),
  detail: (e) => HEADERS[e.id] ?? { requestHeaders: {}, responseHeaders: {} },
  bodyText: (e) => (e.id === 'e1' ? '{"token":"Secret"}' : null),
};

const run = (q: string, caps: FilterCaps = API_FILTER_CAPS, env: MatchEnv = ENV): string[] => {
  const r = buildFilter(q, caps);
  if (!r.ok) throw new Error(`${q}: ${formatFilterError(r.error)}`);
  return ENTRIES.filter((e) => !r.match || r.match(e, env)).map((e) => e.id);
};

describe('predicates: every field and operator', () => {
  const ALL = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'];
  const CASES: [string, string[]][] = [
    ['', ALL],
    // method
    ['method == get', ['e1', 'e3', 'e5']],
    ['method != GET', ['e2', 'e4', 'e6']],
    ['method in {POST, put}', ['e2', 'e4']],
    ['method matches "?E*"', ['e1', 'e3', 'e5', 'e6']],
    // url / host / path / query / scheme / port
    ['url contains /v1/', ['e1', 'e2', 'e5']],
    ['url ~ API.EXAMPLE', ['e1', 'e2', 'e4', 'e5']],
    ['url matches "https://*/v1/*"', ['e1', 'e2', 'e5']],
    ['url matches "https://*"', ['e1', 'e2', 'e4', 'e5', 'e6']],
    ['host == api.example.com', ['e1', 'e2', 'e4', 'e5']],
    ['host == cdn.example.net:8080', ['e3']],
    ['host matches "*.example.*"', ['e1', 'e2', 'e3', 'e4', 'e5']],
    ['path == /v1/login', ['e2']],
    ['path matches "/v?/*"', ['e1', 'e2', 'e4', 'e5']],
    ['path contains "?page="', ['e1']],
    ['query == "page=2"', ['e1']],
    ['(query)', ['e1']],
    // A lone undotted field name is the 0.2 text search; brackets make it a test.
    ['query', []],
    ['scheme == http', ['e3']],
    ['port == 8080', ['e3']],
    ['port == 443', ['e1', 'e2', 'e4', 'e5', 'e6']],
    ['port < 1000', ['e1', 'e2', 'e4', 'e5', 'e6']],
    // status
    ['status == 200', ['e1']],
    ['status == 2xx', ['e1']],
    ['status >= 400', ['e2', 'e4']],
    ['status < 400', ['e1', 'e3']],
    ['status in {304, 5xx}', ['e3', 'e4']],
    ['status == 400-499', ['e2']],
    ['status == 499-400', ['e2']],
    ['status != 200', ['e2', 'e3', 'e4', 'e5', 'e6']],
    ['(status)', ['e1', 'e2', 'e3', 'e4']],
    ['http.response', ['e1', 'e2', 'e3', 'e4']],
    // source / device
    ['source == proxy', ['e3']],
    ['source in {xhr, replay}', ['e2', 'e4', 'e6']],
    ['device == d1', ['e1', 'e2', 'e5']],
    ['device == COM.ACME.APP', ['e1', 'e2', 'e5']],
    ['device contains alias', ['e3', 'e4']],
    ['device.id == alias-2', []],
    ['device.id ~ d', ALL],
    // duration / sizes
    ['duration > 1s', ['e4', 'e6']],
    ['duration <= 120ms', ['e1', 'e3']],
    ['duration >= 0.5m', ['e6']],
    ['duration == 300', ['e2']],
    ['(duration)', ['e1', 'e2', 'e3', 'e4', 'e6']],
    ['size.res > 1kb', ['e1', 'e4']],
    ['size.res >= 1.5mb', ['e4']],
    ['size.res in {128b, 2kb}', ['e1', 'e2']],
    ['size.req == 64', ['e2']],
    ['size.req > 0', ['e2']],
    // time / seq
    ['time > -5m', ['e1', 'e3', 'e4', 'e5', 'e6']],
    ['time < -5m', ['e2']],
    ['time >= -90s and time <= -30s', ['e1']],
    ['time < 2026-10-08T11:55:00Z', ['e2']],
    [`time == ${NOW - 60_000}`, ['e1']],
    ['seq > 4', ['e5', 'e6']],
    ['seq in {1, 3}', ['e1', 'e3']],
    // booleans and error
    ['(completed)', ['e1', 'e2', 'e3', 'e4', 'e6']],
    ['completed', []],
    ['not completed', ['e5']],
    ['completed == false', ['e5']],
    ['completed != true', ['e5']],
    ['(error)', ['e6']],
    ['error contains TIME', ['e6']],
    ['redacted.request', ['e2']],
    ['redacted.response', []],
    ['redacted.request == 0', ['e1', 'e3', 'e4', 'e5', 'e6']],
    // headers and mime (API caps)
    ['mime.res == application/json', ['e1', 'e2']],
    ['mime.res matches "image/*"', ['e3']],
    ['header.authorization', ['e2']],
    ['req.header.AUTHORIZATION contains redacted', ['e2']],
    ['res.header.authorization', []],
    ['res.header.content-type ~ json', ['e1', 'e2']],
    ['header.content-type != image/png', ['e1', 'e2', 'e4', 'e5', 'e6']],
    // text searches and combinations
    ['api.example', ['e1', 'e2', 'e4', 'e5']],
    ['"post "', ['e2']],
    ['method == GET and not status == 2xx', ['e3', 'e5']],
    ['method == GET and not (status == 2xx or status == 3xx)', ['e5']],
    ['status >= 500 or (error)', ['e4', 'e6']],
    ['users or login', ['e1', 'e2']],
    ['v1 !stream', ['e1', 'e2']],
    ['host:cdn or source == replay', ['e3', 'e4']],
  ];
  it.each(CASES)('%s', (q, want) => {
    expect(run(q)).toEqual(want);
  });

  it('body contains reads the supplied body text (UI caps)', () => {
    expect(run('body contains secret', UI_FILTER_CAPS)).toEqual(['e1']);
    expect(run('body:SECRET', UI_FILTER_CAPS)).toEqual(['e1']);
    expect(run('(body)', UI_FILTER_CAPS)).toEqual(['e1']);
  });

  it('a missing env hook makes its fields match nothing', () => {
    expect(run('header.authorization', API_FILTER_CAPS, {})).toEqual([]);
    expect(run('device == com.acme.app', API_FILTER_CAPS, {})).toEqual([]);
    expect(run('body ~ secret', UI_FILTER_CAPS, {})).toEqual([]);
  });

  it('uses the pre-split host/path of a UI row when present', () => {
    const r = buildFilter('host == shown and path == /p', API_FILTER_CAPS);
    if (!r.ok || !r.match) throw new Error('compile');
    expect(r.match({ ...ENTRIES[0], host: 'shown', path: '/p' })).toBe(true);
    expect(r.match(ENTRIES[0])).toBe(false);
  });

  it('relative times read the clock at match time', () => {
    const r = buildFilter('time > -1s', API_FILTER_CAPS);
    if (!r.ok || !r.match) throw new Error('compile');
    const e = base({ startedAt: NOW });
    expect(r.match(e, { now: NOW + 500 })).toBe(true);
    expect(r.match(e, { now: NOW + 5000 })).toBe(false);
  });
});

describe('capabilities', () => {
  it('the UI refuses header and mime fields with a note, at the field offset', () => {
    for (const [q, at] of [['header.x', 0], ['status == 200 and res.header.etag', 18], ['mime.res == a', 0]] as const) {
      const r = buildFilter(q, UI_FILTER_CAPS);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.error.message).toContain('read API'); expect(r.error.offset).toBe(at); }
    }
  });

  it('the API refuses body, including the 0.2 body: term', () => {
    for (const q of ['body ~ x', 'body:x', '(body)']) {
      const r = buildFilter(q, API_FILTER_CAPS);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain('UI search box');
    }
  });

  it('compileFilter defaults to the API capabilities', () => {
    const p = parseFilter('header.x');
    if (!p.ok) throw new Error('parse');
    expect(compileFilter(p.ast).ok).toBe(true);
  });
});

describe('glob matches never backtracks', () => {
  it('a pathological pattern over a long value stays fast and exact', () => {
    const r = buildFilter(`url matches "${'*a'.repeat(200)}*b"`, API_FILTER_CAPS);
    if (!r.ok || !r.match) throw new Error('compile');
    const e = base({ url: `https://x/${'a'.repeat(5000)}` });
    const t0 = performance.now();
    expect(r.match(e)).toBe(false);
    expect(r.match({ ...e, url: `${e.url}b` })).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('performance', () => {
  it('a 2 KB expression over 5,000 entries stays under 1.5 s', () => {
    const group = '(host ~ api and status >= 500 or path matches "/v*/items/*" or duration > 2s) or ';
    let q = '';
    while (q.length + group.length < FILTER_MAX_LENGTH - 20) q += group;
    q += 'method == DELETE';
    expect(q.length).toBeGreaterThan(1900);
    const r = buildFilter(q, API_FILTER_CAPS);
    if (!r.ok || !r.match) throw new Error(r.ok ? 'empty' : formatFilterError(r.error));
    const entries = Array.from({ length: 5000 }, (_, i) => base({
      id: `p${i}`, method: i % 7 === 0 ? 'DELETE' : 'GET', status: 200 + (i % 4) * 100,
      url: `https://host${i % 13}.example/v${i % 3}/things/${i}?q=${'x'.repeat(i % 50)}`, durationMs: i % 3000,
    }));
    const t0 = performance.now();
    let hits = 0;
    for (const e of entries) if (r.match(e, ENV)) hits += 1;
    const elapsed = performance.now() - t0;
    expect(hits).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1500);
  });
});
