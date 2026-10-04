import { describe, it, expect, afterEach } from 'vitest';
import { redactHeaders, redactUrl, redactText, type RedactMark } from '../src/redactor.js';
import { configureRedaction } from '../src/security/sensitiveNames.js';
afterEach(() => configureRedaction({}));
const mark = (): RedactMark => ({ hit: false });
describe('redactor', () => {
  it('masks sensitive headers case-insensitively, keeps others', () => {
    expect(redactHeaders({ 'Access-Token': 'abc', client: 'c1', Accept: 'json', Authorization: 'Bearer x', Cookie: 'a=b', 'Set-Cookie': 'x=y' }))
      .toEqual({ 'Access-Token': '***', client: '***', Accept: 'json', Authorization: '***', Cookie: '***', 'Set-Cookie': '***' });
  });
  it('masks sensitive query params only', () => {
    expect(redactUrl('wss://test.example.io/cable?uid=u%40x.com&client_id=abc&access_token=tok&channel=Friends'))
      .toBe('wss://test.example.io/cable?uid=***&client_id=***&access_token=***&channel=Friends');
  });
  it('returns invalid urls untouched', () => { expect(redactUrl('not a url')).toBe('not a url'); });
  it('masks the uid header (DeviseTokenAuth e-mail)', () => {
    expect(redactHeaders({ uid: 'a@b.com', Uid: 'c@d.com', Accept: 'json' }))
      .toEqual({ uid: '***', Uid: '***', Accept: 'json' });
  });
  it('masks token-like keys inside a JSON string body', () => {
    const s = '{"channel":"Chat","access_token":"SEKRET","uid":"a@b.com","note":"keep"}';
    const out = redactText(s);
    expect(out).not.toContain('SEKRET'); expect(out).not.toContain('a@b.com');
    expect(out).toContain('"note":"keep"'); expect(out).toContain('***');
  });
  it('leaves plain text without sensitive keys untouched', () => {
    expect(redactText('hello world')).toBe('hello world');
    expect(redactText(null)).toBeNull();
  });
});

describe('redactor P5 coverage', () => {
  it('masks the wider header set and reports a hit', () => {
    const m = mark();
    expect(redactHeaders({ 'x-api-key': 'k', 'proxy-authorization': 'p', 'x-amz-security-token': 't', 'X-Session-Id': 's', 'x-request-id': 'r' }, m))
      .toEqual({ 'x-api-key': '***', 'proxy-authorization': '***', 'x-amz-security-token': '***', 'X-Session-Id': '***', 'x-request-id': 'r' });
    expect(m.hit).toBe(true);
  });
  it('leaves a clean header set untouched with no hit', () => {
    const m = mark();
    expect(redactHeaders({ accept: 'json', 'x-author': 'a' }, m)).toEqual({ accept: 'json', 'x-author': 'a' });
    expect(m.hit).toBe(false);
  });
  it('masks query parameters case-insensitively', () => {
    const m = mark();
    expect(redactUrl('https://h.test/p?API_KEY=abc&page=2', m)).toBe('https://h.test/p?API_KEY=***&page=2');
    expect(m.hit).toBe(true);
    const clean = mark();
    expect(redactUrl('https://h.test/p?page=2&shipping=1', clean)).toBe('https://h.test/p?page=2&shipping=1');
    expect(clean.hit).toBe(false);
  });
  it('walks nested JSON by key, masking whole values of any type, objects in arrays included', () => {
    const m = mark();
    const body = '{"user":{"password":"x","profile":{"cardNumber":"4111"}},"items":[{"otp":1}],"credentials":{"a":[1,2]},"name":"n"}';
    const out = redactText(body, 'application/json', m)!;
    expect(JSON.parse(out)).toEqual({ user: { password: '***', profile: { cardNumber: '***' } }, items: [{ otp: '***' }], credentials: '***', name: 'n' });
    expect(m.hit).toBe(true);
  });
  it('preserves the original JSON text (formatting, big numbers) outside masked values', () => {
    const body = '{\n  "id": 12345678901234567890,\n  "token": null,\n  "list": [ { "pin" : true } ]\n}';
    expect(redactText(body, 'application/json')).toBe('{\n  "id": 12345678901234567890,\n  "token": "***",\n  "list": [ { "pin" : "***" } ]\n}');
  });
  it('sniffs JSON without a content type and handles escaped keys', () => {
    expect(JSON.parse(redactText('[{"pass\\u0077ord":"x","ok":"y"}]')!)).toEqual([{ password: '***', ok: 'y' }]);
  });
  it('still covers a JSON string nested inside a JSON string (ActionCable identifier)', () => {
    const frame = JSON.stringify({ command: 'subscribe', identifier: JSON.stringify({ channel: 'C', access_token: 'SEKRET', uid: 'a@b.com' }) });
    const out = redactText(frame)!;
    expect(out).not.toContain('SEKRET'); expect(out).not.toContain('a@b.com');
    expect(JSON.parse(JSON.parse(out).identifier)).toMatchObject({ channel: 'C', access_token: '***', uid: '***' });
  });
  it('falls back to the regex pass on invalid or truncated JSON without throwing', () => {
    const m = mark();
    const out = redactText('{"password":"x","items":[{"otp":"1"', 'application/json', m);
    expect(out).toBe('{"password":"***","items":[{"otp":"***"');
    expect(m.hit).toBe(true);
    expect(() => redactText('{"a":'.repeat(100_000), 'application/json')).not.toThrow();
  });
  it('masks form-urlencoded bodies by parameter name', () => {
    const m = mark();
    expect(redactText('username=a&password=b&client_id=c&pass%77ord=d', 'application/x-www-form-urlencoded; charset=utf-8', m))
      .toBe('username=a&password=***&client_id=***&pass%77ord=***');
    expect(m.hit).toBe(true);
  });
  it('reports no hit for a clean body, and does not count an already-masked value', () => {
    const m = mark();
    expect(redactText('{"page":2,"shipping":"x"}', 'application/json', m)).toBe('{"page":2,"shipping":"x"}');
    expect(redactText('{"token":"***"}', 'application/json', m)).toBe('{"token":"***"}');
    expect(m.hit).toBe(false);
  });
  it('regex pass on other text keeps the old behaviour and adds the shared names', () => {
    expect(redactText("password='x' api_key: \"y\" shipping=\"z\"", 'text/plain')).toBe("password='***' api_key: \"***\" shipping=\"z\"");
  });
  it('honours TERMINUS_REDACT_EXTRA and TERMINUS_REDACT_ALLOW', () => {
    configureRedaction({ extra: ['tenant'], allow: ['nextPageToken', 'authorization'] });
    expect(JSON.parse(redactText('{"tenant":"t","nextPageToken":"n","authorization":"a"}', 'application/json')!))
      .toEqual({ tenant: '***', nextPageToken: 'n', authorization: '***' });
    expect(redactHeaders({ Authorization: 'a', Tenant: 't' })).toEqual({ Authorization: '***', Tenant: '***' });
    expect(redactUrl('https://h.test/?nextPageToken=n&tenant=t')).toBe('https://h.test/?nextPageToken=n&tenant=***');
  });
});

describe('redactor pin: everything the pre-P5 lists masked is still masked', () => {
  it('headers', () => {
    const old = ['access-token', 'client', 'authorization', 'cookie', 'set-cookie', 'uid'];
    for (const h of old) for (const name of [h, h.toUpperCase()]) expect(redactHeaders({ [name]: 'v' })).toEqual({ [name]: '***' });
  });
  it('query', () => {
    expect(redactUrl('https://h.test/?access_token=a&client_id=b&uid=c')).toBe('https://h.test/?access_token=***&client_id=***&uid=***');
  });
  it('text/JSON bodies under the old TEXT_KEY regex', () => {
    const cases = [
      '{"access_token":"SEK"}', '{"access-token":"SEK"}', '{"accesstoken":"SEK"}', '{"client":"SEK"}', '{"authorization":"SEK"}',
      '{"uid":"SEK"}', '{"password":"SEK"}', '{"guid":"SEK"}', '{"my_password":"SEK"}', "{'uid': 'SEK'}", 'uid="SEK"',
      'password: \'SEK\'', '{"x":"{\\"access_token\\":\\"SEK\\"}"}', '{"Access_Token":"SEK"}', 'note {"UID":"SEK"',
      '{"user password":"SEK"}', '{"ns:client":"SEK"}',
    ];
    for (const c of cases) {
      const out = redactText(c);
      expect(out, c).not.toContain('SEK');
      expect(out, c).toContain('***');
    }
  });
});
