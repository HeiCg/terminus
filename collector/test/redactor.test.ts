import { describe, it, expect } from 'vitest';
import { redactHeaders, redactUrl, redactText } from '../src/redactor.js';
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
