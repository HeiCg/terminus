import { describe, it, expect } from 'vitest';
import { validateRulesBody, validateRule, ruleMatches, globMatch, formatRuleError, RULES_MAX, RULE_BODY_MAX, type RuleRequest } from '../src/ruleModel.js';

// U6: the interception rule model. Validation is the contract for PUT /api/rules
// (and the UI form, which runs the same module); matching decides which rules run.

const rule = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: 'r1', name: 'Rule', enabled: true, match: {}, phase: 'request', action: { type: 'delay', ms: 10 }, ...over });
const body = (...rules: unknown[]) => ({ rules });

describe('validateRulesBody', () => {
  it('accepts every action shape and normalizes', () => {
    const r = validateRulesBody(body(
      rule({ id: 'a', name: '  Block ads  ', match: { methods: ['get', 'Post'], host: '*.Ads.Example', path: '/v1/*', query: { page: '?' }, headers: { 'X-Env': 'qa*' }, scheme: 'https' }, action: { type: 'block' } }),
      rule({ id: 'b', action: { type: 'block', status: 451, body: 'nope' } }),
      rule({ id: 'c', action: { type: 'block', close: true } }),
      rule({ id: 'd', action: { type: 'block', reset: true } }),
      rule({ id: 'e', action: { type: 'mock', status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}', delayMs: 0 } }),
      rule({ id: 'f', action: { type: 'mock', status: 204, bodyBase64: 'AAEC' } }),
      rule({ id: 'g', action: { type: 'rewrite', url: '/v2/users?x=1', method: 'put', setHeaders: { 'X-A': '1' }, removeHeaders: ['Cookie'], replace: [{ find: 'a', with: 'b' }] } }),
      rule({ id: 'h', action: { type: 'rewrite', url: 'https://staging.example.com/api', bodyBase64: 'aGk=' } }),
      rule({ id: 'i', phase: 'response', action: { type: 'rewrite', status: 503, body: 'down' } }),
      rule({ id: 'j', phase: 'response', action: { type: 'delay', ms: 30_000 } }),
      { name: 'no id, enabled defaults to true', phase: 'request', action: { type: 'delay', ms: 1 } },
    ), () => 'assigned');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [a, , , , , , g] = r.value;
    expect(a).toEqual({ id: 'a', name: 'Block ads', enabled: true, phase: 'request', action: { type: 'block' },
      match: { methods: ['GET', 'POST'], host: '*.ads.example', path: '/v1/*', query: { page: '?' }, headers: { 'x-env': 'qa*' }, scheme: 'https' } });
    expect(g.action).toEqual({ type: 'rewrite', url: '/v2/users?x=1', method: 'PUT', setHeaders: { 'x-a': '1' }, removeHeaders: ['cookie'], replace: [{ find: 'a', with: 'b' }] });
    expect(r.value[10]).toMatchObject({ id: 'assigned', enabled: true, match: {} });
  });

  const BAD: [string, unknown, string][] = [
    ['not an object', [], ''],
    ['unknown top field', { rules: [], extra: 1 }, 'extra'],
    ['rules not an array', { rules: {} }, 'rules'],
    ['missing id', body(rule({ id: undefined })), 'rules[0].id'],
    ['bad id chars', body(rule({ id: 'a b' })), 'rules[0].id'],
    ['duplicate id', body(rule(), rule()), 'rules[1].id'],
    ['empty name', body(rule({ name: '   ' })), 'rules[0].name'],
    ['enabled not boolean', body(rule({ enabled: 'yes' })), 'rules[0].enabled'],
    ['bad phase', body(rule({ phase: 'both' })), 'rules[0].phase'],
    ['unknown rule field', body(rule({ priority: 1 })), 'rules[0].priority'],
    ['match not object', body(rule({ match: 'x' })), 'rules[0].match'],
    ['empty methods', body(rule({ match: { methods: [] } })), 'rules[0].match.methods'],
    ['bad method', body(rule({ match: { methods: ['G T'] } })), 'rules[0].match.methods[0]'],
    ['host with scheme', body(rule({ match: { host: 'https://a.com' } })), 'rules[0].match.host'],
    ['host with port', body(rule({ match: { host: 'a.com:8080' } })), 'rules[0].match.host'],
    ['host inner wildcard', body(rule({ match: { host: 'a.*.com' } })), 'rules[0].match.host'],
    ['path without slash', body(rule({ match: { path: 'v1/x' } })), 'rules[0].match.path'],
    ['query glob not string', body(rule({ match: { query: { a: 1 } } })), 'rules[0].match.query.a'],
    ['bad header name', body(rule({ match: { headers: { 'x y': '*' } } })), 'rules[0].match.headers.x y'],
    ['bad scheme', body(rule({ match: { scheme: 'ftp' } })), 'rules[0].match.scheme'],
    ['unknown match field', body(rule({ match: { port: 1 } })), 'rules[0].match.port'],
    ['action missing', body(rule({ action: undefined })), 'rules[0].action'],
    ['unknown action', body(rule({ action: { type: 'redirect' } })), 'rules[0].action.type'],
    ['block in response phase', body(rule({ phase: 'response', action: { type: 'block' } })), 'rules[0].action.type'],
    ['mock in response phase', body(rule({ phase: 'response', action: { type: 'mock', status: 200 } })), 'rules[0].action.type'],
    ['block status out of range', body(rule({ action: { type: 'block', status: 99 } })), 'rules[0].action.status'],
    ['block close with status', body(rule({ action: { type: 'block', close: true, status: 403 } })), 'rules[0].action.close'],
    ['block close false', body(rule({ action: { type: 'block', close: false } })), 'rules[0].action.close'],
    ['block close and reset', body(rule({ action: { type: 'block', close: true, reset: true } })), 'rules[0].action.reset'],
    ['mock without status', body(rule({ action: { type: 'mock' } })), 'rules[0].action.status'],
    ['mock body and base64', body(rule({ action: { type: 'mock', status: 200, body: 'a', bodyBase64: 'YQ==' } })), 'rules[0].action.bodyBase64'],
    ['mock bad base64', body(rule({ action: { type: 'mock', status: 200, bodyBase64: 'not base64!' } })), 'rules[0].action.bodyBase64'],
    ['mock content-length header', body(rule({ action: { type: 'mock', status: 200, headers: { 'Content-Length': '3' } } })), 'rules[0].action.headers.Content-Length'],
    ['mock header with newline', body(rule({ action: { type: 'mock', status: 200, headers: { a: 'x\r\nb: y' } } })), 'rules[0].action.headers.a'],
    ['mock delay over cap', body(rule({ action: { type: 'mock', status: 200, delayMs: 30_001 } })), 'rules[0].action.delayMs'],
    ['mock body over 1 MiB', body(rule({ action: { type: 'mock', status: 200, body: 'x'.repeat(RULE_BODY_MAX + 1) } })), 'rules[0].action.body'],
    ['delay zero', body(rule({ action: { type: 'delay', ms: 0 } })), 'rules[0].action.ms'],
    ['delay over cap', body(rule({ action: { type: 'delay', ms: 30_001 } })), 'rules[0].action.ms'],
    ['delay fractional', body(rule({ action: { type: 'delay', ms: 1.5 } })), 'rules[0].action.ms'],
    ['rewrite with nothing', body(rule({ action: { type: 'rewrite' } })), 'rules[0].action'],
    ['rewrite status in request phase', body(rule({ action: { type: 'rewrite', status: 500 } })), 'rules[0].action.status'],
    ['rewrite url in response phase', body(rule({ phase: 'response', action: { type: 'rewrite', url: '/x' } })), 'rules[0].action.url'],
    ['rewrite method in response phase', body(rule({ phase: 'response', action: { type: 'rewrite', method: 'GET' } })), 'rules[0].action.method'],
    ['rewrite url relative', body(rule({ action: { type: 'rewrite', url: 'v2/x' } })), 'rules[0].action.url'],
    ['rewrite url ftp', body(rule({ action: { type: 'rewrite', url: 'ftp://a.com/x' } })), 'rules[0].action.url'],
    ['rewrite url to metadata', body(rule({ action: { type: 'rewrite', url: 'http://169.254.169.254/latest' } })), 'rules[0].action.url'],
    ['rewrite remove transfer-encoding', body(rule({ action: { type: 'rewrite', removeHeaders: ['Transfer-Encoding'] } })), 'rules[0].action.removeHeaders[0]'],
    ['rewrite replace empty find', body(rule({ action: { type: 'rewrite', replace: [{ find: '', with: 'x' }] } })), 'rules[0].action.replace[0].find'],
    ['rewrite replace over 50', body(rule({ action: { type: 'rewrite', replace: Array.from({ length: 51 }, () => ({ find: 'a', with: 'b' })) } })), 'rules[0].action.replace'],
    ['rewrite replace unknown key', body(rule({ action: { type: 'rewrite', replace: [{ find: 'a', with: 'b', all: true }] } })), 'rules[0].action.replace[0].all'],
    ['too many rules', { rules: Array.from({ length: RULES_MAX + 1 }, (_, i) => rule({ id: `r${i}` })) }, 'rules'],
  ];
  for (const [label, input, path] of BAD) {
    it(`refuses ${label} at ${path || '(body)'}`, () => {
      const r = validateRulesBody(input);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.path).toBe(path);
        expect(formatRuleError(r)).toContain(r.message);
      }
    });
  }

  it('allows 200 rules', () => {
    expect(validateRulesBody({ rules: Array.from({ length: RULES_MAX }, (_, i) => rule({ id: `r${i}` })) }).ok).toBe(true);
  });

  it('validateRule reports the path under the given prefix', () => {
    const r = validateRule(rule({ action: { type: 'block', status: 700 } }), 'rule');
    expect(r).toEqual({ ok: false, path: 'rule.action.status', message: 'must be an integer from 200 to 599' });
  });
});

describe('globMatch', () => {
  const CASES: [string, string, boolean][] = [
    ['/v1/*', '/v1/users/2', true],
    ['/v1/*', '/v1/', true],
    ['/v1/*', '/v2/users', false],
    ['/v?/users', '/v2/users', true],
    ['/v?/users', '/v10/users', false],
    ['*', '', true],
    ['', '', true],
    ['', 'x', false],
    ['*.json', '/a/b.json', true],
    ['/a*b*c', '/axxbyyc', true],
    ['/a*b*c', '/axxbyy', false],
    ['/Users', '/users', false], // case-sensitive
    ['a**b', 'ab', true],
  ];
  for (const [p, t, want] of CASES) it(`${JSON.stringify(p)} vs ${JSON.stringify(t)} -> ${want}`, () => expect(globMatch(p, t)).toBe(want));

  it('stays linear-ish on a pathological pattern', () => {
    const t0 = Date.now();
    expect(globMatch('*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('ruleMatches', () => {
  const req = (over: Partial<RuleRequest> = {}): RuleRequest =>
    ({ method: 'GET', url: 'https://api.example.com/v1/users?page=2&tag=a&tag=b', headers: { 'x-env': 'qa-1', accept: ['text/html', 'application/json'] }, ...over });
  const m = (match: Record<string, unknown>, r: RuleRequest = req()): boolean => {
    const v = validateRule(rule({ match }));
    if (!v.ok) throw new Error(formatRuleError(v));
    return ruleMatches(v.value.match, r);
  };

  it('an empty match matches everything', () => expect(m({})).toBe(true));
  it('methods', () => {
    expect(m({ methods: ['post', 'get'] })).toBe(true);
    expect(m({ methods: ['POST'] })).toBe(false);
    expect(m({ methods: ['POST'] }, req({ method: 'post' }))).toBe(true);
  });
  it('host exact and wildcard (case-insensitive, wildcard excludes the apex)', () => {
    expect(m({ host: 'API.example.com' })).toBe(true);
    expect(m({ host: 'example.com' })).toBe(false);
    expect(m({ host: '*.example.com' })).toBe(true);
    expect(m({ host: '*.example.com' }, req({ url: 'https://example.com/' }))).toBe(false);
    expect(m({ host: '*.example.com' }, req({ url: 'https://a.b.example.com/' }))).toBe(true);
    expect(m({ host: '*.example.com' }, req({ url: 'https://badexample.com/' }))).toBe(false);
    expect(m({ host: '127.0.0.1' }, req({ url: 'http://127.0.0.1:8080/x' }))).toBe(true);
  });
  it('path glob over the path only', () => {
    expect(m({ path: '/v1/*' })).toBe(true);
    expect(m({ path: '/v1/users' })).toBe(true);
    expect(m({ path: '/v1/user?' })).toBe(true);
    expect(m({ path: '/v2/*' })).toBe(false);
    expect(m({ path: '*page*' })).toBe(false); // the query is not part of the path
  });
  it('query globs: every named parameter present, any repeated value', () => {
    expect(m({ query: { page: '2' } })).toBe(true);
    expect(m({ query: { page: '?', tag: 'b' } })).toBe(true);
    expect(m({ query: { page: '3' } })).toBe(false);
    expect(m({ query: { missing: '*' } })).toBe(false);
  });
  it('header globs: name case-insensitive, any repeated value', () => {
    expect(m({ headers: { 'X-Env': 'qa-*' } })).toBe(true);
    expect(m({ headers: { accept: 'application/*' } })).toBe(true);
    expect(m({ headers: { 'x-env': 'prod*' } })).toBe(false);
    expect(m({ headers: { authorization: '*' } })).toBe(false);
  });
  it('scheme', () => {
    expect(m({ scheme: 'https' })).toBe(true);
    expect(m({ scheme: 'http' })).toBe(false);
    expect(m({ scheme: 'http' }, req({ url: 'http://api.example.com/' }))).toBe(true);
  });
  it('all criteria AND together', () => {
    expect(m({ methods: ['GET'], host: '*.example.com', path: '/v1/*', query: { page: '2' }, headers: { 'x-env': 'qa*' }, scheme: 'https' })).toBe(true);
    expect(m({ methods: ['GET'], host: '*.example.com', path: '/v1/*', query: { page: '2' }, headers: { 'x-env': 'qa*' }, scheme: 'http' })).toBe(false);
  });
});
