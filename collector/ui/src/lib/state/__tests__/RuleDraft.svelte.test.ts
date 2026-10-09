import { describe, it, expect } from 'vitest';
import { RuleDraft, offerRuleSeed, takeRuleSeed } from '../RuleDraft.svelte.js';
import type { Rule } from '../../ruleModel.js';

// U6: the rule form's state. Validation is the shared rule model (the collector
// runs the same code on PUT /api/rules); these tests pin how the typed fields map
// to a rule and which field each message lands on.

function valid(d: RuleDraft): Rule {
  const c = d.check;
  if (!c.ok) throw new Error(`${c.field}: ${c.message}`);
  return c.rule;
}

describe('RuleDraft', () => {
  it('a fresh draft needs a name, then is a valid 403 block', () => {
    const d = new RuleDraft();
    expect(d.check).toEqual({ ok: false, field: 'name', message: 'must not be empty' });
    expect(d.errorFor('name')).toBe('must not be empty');
    d.name = 'Block ads';
    expect(valid(d)).toEqual({ id: 'new', name: 'Block ads', enabled: true, phase: 'request', match: {}, action: { type: 'block' } });
  });

  it('builds match criteria from the text fields', () => {
    const d = new RuleDraft();
    d.name = 'x';
    d.methods = 'get, post';
    d.host = '*.Example.com';
    d.path = '/v1/*';
    d.scheme = 'https';
    d.query = 'page=2\n\n tag = a* ';
    d.headers = 'X-Env: qa*';
    expect(valid(d).match).toEqual({ methods: ['GET', 'POST'], host: '*.example.com', path: '/v1/*', scheme: 'https', query: { page: '2', tag: 'a*' }, headers: { 'x-env': 'qa*' } });
  });

  it('puts each problem on its field', () => {
    const d = new RuleDraft();
    d.name = 'x';
    d.host = 'a.com:8080';
    expect(d.errorFor('match.host')).toBe('a port or IPv6 literal is not allowed');
    expect(d.errorFor('match')).toBe('a port or IPv6 literal is not allowed');
    expect(d.errorFor('name')).toBeNull();
    d.host = '';
    d.query = 'no-equals-sign';
    expect(d.check).toEqual({ ok: false, field: 'match.query', message: 'line 1: expected name=value' });
    d.query = '';
    d.status = '99';
    expect(d.errorFor('action.status')).toBe('must be an integer from 200 to 599');
    d.status = 'abc';
    expect(d.errorFor('action.status')).toBe('must be an integer from 200 to 599');
    d.status = '';
    d.actionType = 'delay';
    d.delayMs = '40000';
    expect(d.errorFor('action.ms')).toBe('must be an integer from 1 to 30000');
    d.actionType = 'rewrite';
    expect(d.errorFor('action', true)).toBe('a rewrite must change something');
    expect(d.errorFor('action.url', true)).toBeNull();
  });

  it('builds each action', () => {
    const d = new RuleDraft();
    d.name = 'x';
    d.blockMode = 'close';
    expect(valid(d).action).toEqual({ type: 'block', close: true });
    d.actionType = 'mock';
    d.status = '201';
    d.mockHeaders = 'Content-Type: application/json';
    d.body = '{"ok":true}';
    d.mockDelay = '250';
    expect(valid(d).action).toEqual({ type: 'mock', status: 201, headers: { 'content-type': 'application/json' }, body: '{"ok":true}', delayMs: 250 });
    d.body = 'AAEC';
    d.bodyIsBase64 = true;
    expect(valid(d).action).toMatchObject({ bodyBase64: 'AAEC' });
    d.bodyIsBase64 = false;
    d.body = '';
    d.actionType = 'rewrite';
    d.url = '/v2/x';
    d.method = 'put';
    d.setHeaders = 'X-A: 1';
    d.removeHeaders = 'cookie, x-b';
    d.addReplace();
    d.replace[0].find = 'a';
    d.replace[0].with = 'b';
    d.addReplace(); // an empty row is ignored
    expect(valid(d).action).toEqual({ type: 'rewrite', url: '/v2/x', method: 'PUT', setHeaders: { 'x-a': '1' }, removeHeaders: ['cookie', 'x-b'], replace: [{ find: 'a', with: 'b' }] });
    d.removeReplace(1);
    expect(d.replace).toHaveLength(1);
  });

  it('switching to the response phase keeps only the actions that phase allows', () => {
    const d = new RuleDraft();
    d.name = 'x';
    expect(d.actions).toEqual(['block', 'mock', 'rewrite', 'delay']);
    d.setPhase('response');
    expect(d.actions).toEqual(['rewrite', 'delay']);
    expect(d.actionType).toBe('rewrite');
    // A response rewrite ignores the request-only URL field and takes a status.
    d.url = '/ignored';
    d.status = '503';
    expect(valid(d).action).toEqual({ type: 'rewrite', status: 503 });
    d.actionType = 'delay';
    d.setPhase('request');
    expect(d.actionType).toBe('delay');
  });

  it('round-trips an existing rule through the form', () => {
    const rules: Rule[] = [
      { id: 'a', name: 'A', enabled: false, phase: 'request', match: { methods: ['POST'], host: 'api.test', query: { q: '*' }, headers: { 'x-a': 'b' } }, action: { type: 'mock', status: 200, headers: { 'content-type': 'text/plain' }, bodyBase64: 'aGk=', delayMs: 5 } },
      { id: 'b', name: 'B', enabled: true, phase: 'response', match: {}, action: { type: 'rewrite', status: 500, setHeaders: { 'x-y': 'z' }, removeHeaders: ['etag'], body: 'x', replace: [{ find: 'a', with: 'b' }] } },
      { id: 'c', name: 'C', enabled: true, phase: 'request', match: { path: '/x', scheme: 'http' }, action: { type: 'block', status: 451, body: 'no' } },
      { id: 'd', name: 'D', enabled: true, phase: 'request', match: {}, action: { type: 'block', reset: true } },
      { id: 'e', name: 'E', enabled: true, phase: 'response', match: {}, action: { type: 'delay', ms: 100 } },
    ];
    for (const r of rules) expect(valid(RuleDraft.fromRule(r))).toEqual(r);
  });

  it('a seed from Capture prefills a mock of that request', () => {
    offerRuleSeed({ method: 'POST', host: 'api.test', path: '/login' });
    const seed = takeRuleSeed();
    expect(takeRuleSeed()).toBeNull(); // taken once
    const d = RuleDraft.fromSeed(seed!);
    expect(valid(d)).toMatchObject({ name: 'POST api.test/login', match: { methods: ['POST'], host: 'api.test', path: '/login' }, action: { type: 'mock', status: 200, headers: { 'content-type': 'application/json' } } });
  });
});
