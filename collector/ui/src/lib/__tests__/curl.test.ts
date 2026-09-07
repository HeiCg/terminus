import { describe, it, expect } from 'vitest';
import { buildCurl } from '../curl.js';
import type { EntryDetail } from '../protocol.js';

const absent = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null } as const;

function detail(over: Partial<EntryDetail> = {}): EntryDetail {
  return {
    id: 'r1', deviceId: 'd1', source: 'atlantis', startedAt: 1, method: 'GET',
    url: 'https://api.test/thing', status: 200, durationMs: 1, error: null,
    requestBody: absent, responseBody: absent,
    requestHeaders: {}, responseHeaders: {}, statusText: 'OK', ...over,
  };
}

describe('buildCurl', () => {
  it('returns empty string with no row', () => {
    expect(buildCurl(null, null, null)).toBe('');
  });

  it('emits a bare GET with no data segment', () => {
    const out = buildCurl({ method: 'GET', url: 'https://api.test/thing' }, detail(), null);
    expect(out).toBe("curl -X GET 'https://api.test/thing'");
    expect(out).not.toContain('--data-raw');
  });

  it('emits headers and an escaped POST body', () => {
    const out = buildCurl(
      { method: 'POST', url: "https://api.test/it's" },
      detail({ method: 'POST', requestHeaders: { 'content-type': 'application/json', 'x-a': 'b' } }),
      `{"q":"o'clock"}`,
    );
    expect(out).toContain('curl -X POST');
    // single quotes in the URL are shell-escaped
    expect(out).toContain("'https://api.test/it'\\''s'");
    expect(out).toContain("-H 'content-type: application/json'");
    expect(out).toContain("-H 'x-a: b'");
    // single quotes in the body are shell-escaped
    expect(out).toContain("--data-raw '{\"q\":\"o'\\''clock\"}'");
    // line continuations join the segments
    expect(out).toContain(' \\\n');
  });

  it('annotates an omitted request body instead of sending data', () => {
    const out = buildCurl(
      { method: 'POST', url: 'https://api.test/up' },
      detail({ method: 'POST' }),
      null,
      'size',
    );
    expect(out).not.toContain('--data-raw');
    expect(out).toContain('# request body omitted (size)');
  });

  it('annotates a request body that exists but could not be loaded', () => {
    const out = buildCurl(
      { method: 'POST', url: 'https://api.test/up' },
      detail({ method: 'POST' }),
      null,
      undefined,
      1234,
    );
    expect(out).not.toContain('--data-raw');
    expect(out).toContain('# request body (1234 bytes) not loaded');
  });

  it('prefers real data over the not-loaded note when the body is present', () => {
    const out = buildCurl(
      { method: 'POST', url: 'https://api.test/up' },
      detail({ method: 'POST' }),
      '{"a":1}',
      undefined,
      1234,
    );
    expect(out).toContain('--data-raw');
    expect(out).not.toContain('not loaded');
  });
});
