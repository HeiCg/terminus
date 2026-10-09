import { describe, it, expect, vi } from 'vitest';
import { ReplayDraft, capturedBodyOf, type CapturedBody } from '../ReplayDraft.svelte.js';

function draft(body: CapturedBody = { kind: 'text', text: '{"a":1}' }, headers: Record<string, string> = { 'content-type': 'application/json', authorization: '***' }) {
  return new ReplayDraft('d1', 'r1', { method: 'POST', url: 'https://api.test/v1/items', headers, body });
}

function okFetch(response: Record<string, unknown> = {}) {
  const sent: unknown[] = [];
  const f = vi.fn(async (_u: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string));
    return {
      ok: true,
      json: async () => ({ key: { deviceId: 'd1', id: 'replay-1' }, status: 200, error: null, stripped: [], ...response }),
      text: async () => '',
    } as unknown as Response;
  });
  return { f: f as unknown as typeof fetch, sent };
}

describe('ReplayDraft prefill', () => {
  it('prefills method, url, header rows and a text body', () => {
    const d = draft();
    expect(d.method).toBe('POST');
    expect(d.url).toBe('https://api.test/v1/items');
    expect(d.headers.map((h) => [h.name, h.value])).toEqual([['content-type', 'application/json'], ['authorization', '***']]);
    expect(d.bodyMode).toBe('text');
    expect(d.text).toBe('{"a":1}');
    expect(d.byteCount).toBe(7);
  });

  it('opens a binary body in hex mode', () => {
    const d = draft({ kind: 'bytes', bytes: new Uint8Array([0, 255]) });
    expect(d.bodyMode).toBe('hex');
    expect(Array.from(d.hex.bytes)).toEqual([0, 255]);
    expect(d.byteCount).toBe(2);
  });

  it('maps loaded body states to a captured body', () => {
    expect(capturedBodyOf({ kind: 'ok', hash: 'h', size: 2, encoding: 'binary' }, 'AP8=')).toEqual({ kind: 'bytes', bytes: new Uint8Array([0, 255]) });
    expect(capturedBodyOf({ kind: 'ok', hash: 'h', size: 2, encoding: 'utf8' }, 'hi')).toEqual({ kind: 'text', text: 'hi' });
    expect(capturedBodyOf({ kind: 'absent' }, undefined)).toEqual({ kind: 'none' });
    expect(capturedBodyOf({ kind: 'omitted', reason: 'size', size: 9 }, undefined)).toEqual({ kind: 'unavailable', reason: 'size' });
  });
});

describe('ReplayDraft overrides', () => {
  it('an untouched draft sends no overrides (same as the quick replay)', () => {
    expect(draft().request()).toEqual({ deviceId: 'd1', id: 'r1', credentials: 'strip' });
    expect(draft({ kind: 'bytes', bytes: new Uint8Array([1]) }).request()).toEqual({ deviceId: 'd1', id: 'r1', credentials: 'strip' });
  });

  it('sends only the changed method, url and the full header map once headers change', () => {
    const d = draft();
    d.method = 'put';
    d.url = 'https://api.test/v2';
    d.headers[0].value = 'text/plain';
    d.addHeader();
    d.headers[2].name = 'x-debug';
    d.headers[2].value = '1';
    d.addHeader(); // a blank row is ignored
    expect(d.request().overrides).toEqual({
      method: 'put', url: 'https://api.test/v2',
      headers: { 'content-type': 'text/plain', authorization: '***', 'x-debug': '1' },
    });
  });

  it('removing a header row sends the reduced map', () => {
    const d = draft();
    d.removeHeader(d.headers[1].key);
    expect(d.request().overrides).toEqual({ headers: { 'content-type': 'application/json' } });
  });

  it('an edited text body goes as body', () => {
    const d = draft();
    d.text = '{"a":2}';
    expect(d.request().overrides).toEqual({ body: '{"a":2}' });
  });

  it('a hex edit goes as bodyBase64', () => {
    const d = draft({ kind: 'bytes', bytes: new Uint8Array([1, 2]) });
    d.hex.moveTo(2);
    d.hex.typeHex('f'); d.hex.typeHex('f');
    expect(d.request().overrides).toEqual({ bodyBase64: 'AQL/' });
  });

  it('switching text to hex keeps the bytes; an unchanged switch sends nothing', () => {
    const d = draft({ kind: 'text', text: 'hi' });
    expect(d.setBodyMode('hex')).toBe(true);
    expect(Array.from(d.hex.bytes)).toEqual([0x68, 0x69]);
    expect(d.request().overrides).toBeUndefined();
    d.hex.insertByte(0);
    expect(d.request().overrides).toEqual({ bodyBase64: 'AGhp' });
  });

  it('hex to text is refused for bytes that are not UTF-8', () => {
    const d = draft({ kind: 'bytes', bytes: new Uint8Array([0xff]) });
    expect(d.setBodyMode('text')).toBe(false);
    expect(d.bodyMode).toBe('hex');
    expect(d.modeError).toContain('not valid UTF-8');
  });

  it('an unavailable body sends nothing until content is entered', () => {
    const d = draft({ kind: 'unavailable', reason: 'size' });
    expect(d.request().overrides).toBeUndefined();
    d.text = 'new';
    expect(d.request().overrides).toEqual({ body: 'new' });
  });
});

describe('ReplayDraft credentials and send', () => {
  it('strips by default and resolves to the new key', async () => {
    const d = draft();
    const { f, sent } = okFetch({ stripped: ['authorization'] });
    const key = await d.send(f);
    expect(key).toEqual({ deviceId: 'd1', id: 'replay-1' });
    expect((sent[0] as { credentials: string }).credentials).toBe('strip');
    expect(d.phase).toBe('done');
    expect(d.message).toBe('sent · 200');
    expect(d.stripped).toEqual(['authorization']);
  });

  it('with credentials the first send only arms; the second sends keep', async () => {
    const d = draft();
    const { f, sent } = okFetch();
    d.setWithCreds(true);
    expect(await d.send(f)).toBeNull();
    expect(d.armed).toBe(true);
    expect(sent).toHaveLength(0);
    await d.send(f);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { credentials: string }).credentials).toBe('keep');
  });

  it('toggling credentials disarms the confirmation', async () => {
    const d = draft();
    const { f, sent } = okFetch();
    d.setWithCreds(true);
    await d.send(f); // arm
    d.setWithCreds(false);
    expect(d.armed).toBe(false);
    await d.send(f);
    expect((sent[0] as { credentials: string }).credentials).toBe('strip');
  });

  it('a refused replay shows the server message', async () => {
    const d = draft({ kind: 'unavailable', reason: 'size' });
    const f = vi.fn(async () => ({ ok: false, status: 422, text: async () => '{"error":"original request body was not retained (size)"}' })) as unknown as typeof fetch;
    expect(await d.send(f)).toBeNull();
    expect(d.phase).toBe('error');
    expect(d.message).toBe('original request body was not retained (size)');
  });
});
