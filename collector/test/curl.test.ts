import { describe, it, expect } from 'vitest';
import { toCurl } from '../src/curl.js';
describe('toCurl', () => {
  it('builds a curl with headers and body', () => {
    expect(toCurl({ id: '1', deviceId: 'd', source: 'xhr', startedAt: 0, method: 'POST', url: "https://x/y?a=b'c", requestHeaders: { 'content-type': 'application/json', 'access-token': '***' }, requestBody: '{"a":"it\'s"}', requestBodySize: 0, status: null, statusText: '', responseHeaders: {}, responseBody: null, responseBodySize: 0, durationMs: null, error: null }))
      .toBe(`curl -X POST 'https://x/y?a=b'\\''c' -H 'content-type: application/json' -H 'access-token: ***' --data-raw '{"a":"it'\\''s"}'`);
  });
  it('omits --data-raw for GET without body', () => {
    expect(toCurl({ id: '1', deviceId: 'd', source: 'xhr', startedAt: 0, method: 'GET', url: 'https://x', requestHeaders: {}, requestBody: null, requestBodySize: 0, status: null, statusText: '', responseHeaders: {}, responseBody: null, responseBodySize: 0, durationMs: null, error: null }))
      .toBe(`curl -X GET 'https://x'`);
  });
});
