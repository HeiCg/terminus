import { describe, it, expect } from 'vitest';
import { parseQuery, matchQuery } from '../query.js';
import { buildFilter, UI_FILTER_CAPS } from '../filterLang.js';
import { splitUrl } from '../format.js';
import type { EntrySummary, BodyRef } from '../protocol.js';

// U2 backward compatibility: every query form the 0.2 mini-query accepted must
// select exactly the same rows under the filter language. The frozen 0.2
// matcher (query.ts) is the oracle; each case runs both over the same rows.

const ref = (sha: string | null): BodyRef => ({ state: sha ? 'captured' : 'absent', sha256: sha, size: sha ? 10 : 0, storedSize: 0, encoding: 'utf8', omitted: null });
type Row = EntrySummary & { host: string; path: string };
const row = (id: string, over: Partial<EntrySummary>): Row => {
  const e: EntrySummary = {
    id, deviceId: 'phone-1', source: 'atlantis', startedAt: 0, method: 'GET', url: 'https://api.test/users',
    status: 200, durationMs: 1, error: null, requestBody: ref(null), responseBody: ref(null), ...over,
  };
  return { ...e, ...splitUrl(e.url) };
};

const ROWS: Row[] = [
  row('r1', {}),
  row('r2', { method: 'POST', url: 'https://API.test/v2/Login?next=/home', status: 201, source: 'xhr', responseBody: ref('b1') }),
  row('r3', { method: 'delete', url: 'http://cdn.example:8080/a b/img.png', status: 404, source: 'proxy', deviceId: 'Tablet-9' }),
  row('r4', { url: 'https://api.test/status/error', status: 503, source: 'replay', requestBody: ref('b2') }),
  row('r5', { method: 'PUT', url: 'https://other.test/x,y', status: null, error: 'timeout', deviceId: 'phone-2' }),
  row('r6', { method: 'OPTIONS', url: 'not a url', status: 999 }),
  row('r7', { url: 'https://api.test/host:api/redacted.request/"quoted"', status: 302, source: 'XHR' as EntrySummary['source'] }),
  row('r8', { method: 'GET', url: 'https://api.test/path/with spaces?q=two words', status: 100 }),
];
const BODIES: Record<string, string> = { b1: '{"Token":"Secret"}', b2: 'plain request body' };
const bodyText = (r: EntrySummary): string | null => BODIES[r.responseBody.sha256 ?? ''] ?? BODIES[r.requestBody.sha256 ?? ''] ?? null;

// Every 0.2 form: empty, free terms, quoting, each typed key and its list /
// class / range / lenient variants, repeats (OR), mixes (AND), unknown keys,
// odd characters 0.2 treated as plain text.
const LEGACY: string[] = [
  '', ' ', '   ',
  'users', 'USERS', 'get', 'post login', 'api.test', 'zzz', 'error', 'status', 'host', 'path', 'completed', 'query', 'time',
  '"two words"', '"a b"', 'a" "b', '"unterminated', '""', '"', 'host:"api v2"', '"host:api"', 'path:"with spaces"',
  'method:get', 'method:GET,post', 'method:,', 'method:,get,', 'method:Delete', 'method:', 'METHOD:put',
  'status:200', 'status:2xx', 'status:5XX', 'status:400-499', 'status:499-400', 'status:200,404', 'status:nope',
  'status:2xx,nope', 'status:', 'status:999', 'status:100-199', 'status: 200', 'status:6xx', 'status:20',
  'host:api', 'host:API.TEST', 'host:8080', 'host:', 'host:a host:cdn', 'host:zz host:other',
  'path:/users', 'path:next=', 'path:LOGIN', 'path:/a',
  'source:xhr', 'source:XHR', 'source:proxy', 'source:nope', 'source:prox', 'source:xhr source:proxy',
  'device:phone', 'device:tablet', 'device:PHONE-2', 'device:',
  'body:secret', 'body:token', 'body:plain', 'body:none', 'body:',
  'foo:bar', 'url:users', 'time:5', 'host:api users', 'method:get host:api.test users',
  'method:get status:2xx', 'method:get,post status:2xx,404 host:api', 'status:5xx source:replay body:request',
  'a,b', 'x,y', '/x,y', '-5m', '1.5mb', '@#$%', 'next=/home', 'q=two&x', 'a|b', 'host:api.test path:/v2 method:post',
  'body:{"a":1}', 'path:/a(b)', 'host:a==b',
  'Host:api', 'BODY:Secret', 'status:2xx status:4xx', 'device:phone device:tablet',
];

describe('0.2 mini-query backward compatibility (U2)', () => {
  it.each(LEGACY)('%j selects the same rows as 0.2', (q) => {
    const want = ROWS.filter((r) => matchQuery(parseQuery(q), r, bodyText)).map((r) => r.id);
    const built = buildFilter(q, UI_FILTER_CAPS);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const got = ROWS.filter((r) => !built.match || built.match(r, { bodyText })).map((r) => r.id);
    expect(got).toEqual(want);
  });

  // The documented departures: a lone dotted field name is now a field test, and
  // free text with expression syntax or a bare keyword is an expression (quote
  // it to search for it as text).
  it.each([
    ['redacted.request', '"redacted.request"'],
    ['(foo)', '"(foo)"'],
    ['!important', '"!important"'],
    ['sign in', '"sign in"'],
    ['a==b', '"a==b"'],
  ])('%s departs from 0.2; %s is the text search', (changed, quoted) => {
    const before = ROWS.filter((r) => matchQuery(parseQuery(changed), r, bodyText)).map((r) => r.id);
    const r = buildFilter(quoted, UI_FILTER_CAPS);
    if (!r.ok || !r.match) throw new Error('compile');
    const m = r.match;
    expect(ROWS.filter((x) => m(x, { bodyText })).map((x) => x.id)).toEqual(before);
  });

  it('a lone dotted field name is a field test now, not a text search', () => {
    const r = buildFilter('redacted.request', UI_FILTER_CAPS);
    if (!r.ok || !r.match) throw new Error('compile');
    // r7's url contains the text, but r7 carries no redaction.
    expect(r.match(ROWS[6])).toBe(false);
    expect(r.match({ ...ROWS[6], redacted: { request: true, response: false } })).toBe(true);
  });

  it('every 0.2 form is read the 0.2 way (no expression syntax involved)', () => {
    for (const q of LEGACY) {
      const r = buildFilter(q, UI_FILTER_CAPS);
      expect(r.ok && r.legacy).toBe(true);
    }
  });
});
