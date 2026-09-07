import { describe, it, expect } from 'vitest';
import { toHar } from '../src/har.js';
import type { Entry } from '../src/types.js';
const e: Entry = { id: '1', deviceId: 'd', source: 'xhr', startedAt: 1700000000000, method: 'POST', url: 'https://api.example.io/api/v1/login?x=1',
  requestHeaders: { 'content-type': 'application/json' }, requestBody: '{"a":1}', requestBodySize: 7, requestBodyOmitted: null,
  status: 201, statusText: 'Created', responseHeaders: { 'content-type': 'application/json' }, responseBody: '{"ok":true}', responseBodySize: 11, responseBodyOmitted: null, durationMs: 123, error: null };
describe('toHar', () => {
  it('produces HAR 1.2 with one entry per Entry', () => {
    const har = toHar([e, { ...e, id: '2' }, { ...e, id: '3' }]);
    expect(har.log.version).toBe('1.2'); expect(har.log.creator.name).toBe('terminus');
    expect(har.log.entries).toHaveLength(3);
    const h = har.log.entries[0];
    expect(h.startedDateTime).toBe('2023-11-14T22:13:20.000Z');
    expect(h.time).toBe(123);
    expect(h.request).toMatchObject({ method: 'POST', url: e.url, httpVersion: 'HTTP/1.1', headers: [{ name: 'content-type', value: 'application/json' }], queryString: [{ name: 'x', value: '1' }], postData: { mimeType: 'application/json', text: '{"a":1}' }, headersSize: -1, bodySize: 7 });
    expect(h.response).toMatchObject({ status: 201, statusText: 'Created', content: { size: 11, mimeType: 'application/json', text: '{"ok":true}' }, headersSize: -1, bodySize: 11, redirectURL: '' });
    expect(h.timings).toEqual({ send: 0, wait: 123, receive: 0 });
  });
  it('maps pending/error entries to status 0', () => {
    const h = toHar([{ ...e, status: null, durationMs: null, error: 'timeout' }]).log.entries[0];
    expect(h.response.status).toBe(0); expect(h.time).toBe(-1); expect(h.comment).toBe('error: timeout');
  });
  it('conforms to the required HAR 1.2 structure', () => {
    const har = toHar([e, { ...e, id: '2', status: null, durationMs: null }]) as unknown as Record<string, any>;
    expect(har.log.version).toBe('1.2');
    expect(typeof har.log.creator.name).toBe('string');
    expect(typeof har.log.creator.version).toBe('string');
    expect(Array.isArray(har.log.entries)).toBe(true);
    for (const en of har.log.entries) {
      // startedDateTime must be a valid ISO-8601 date HAR requires
      expect(Number.isNaN(Date.parse(en.startedDateTime))).toBe(false);
      expect(typeof en.time).toBe('number');
      for (const side of ['request', 'response'] as const) {
        expect(Array.isArray(en[side].headers)).toBe(true);
        expect(Array.isArray(en[side].cookies)).toBe(true);
        for (const hh of en[side].headers) { expect(typeof hh.name).toBe('string'); expect(typeof hh.value).toBe('string'); }
      }
      expect(typeof en.request.method).toBe('string');
      expect(typeof en.request.url).toBe('string');
      expect(Array.isArray(en.request.queryString)).toBe(true);
      expect(typeof en.request.headersSize).toBe('number');
      expect(typeof en.request.bodySize).toBe('number');
      expect(typeof en.response.status).toBe('number');
      expect(typeof en.response.content.size).toBe('number');
      expect(typeof en.response.content.mimeType).toBe('string');
      expect(typeof en.response.redirectURL).toBe('string');
      expect(en.timings).toMatchObject({ send: expect.any(Number), wait: expect.any(Number), receive: expect.any(Number) });
      expect(en.cache).toBeTypeOf('object');
    }
  });
});
