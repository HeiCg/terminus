import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchBody, fetchFrameBody, clear } from '../api.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function res(init: { status: number; text?: string; omitted?: string; bytes?: Uint8Array }): Response {
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers: {
      get: (k: string) => (k === 'x-body-omitted' ? init.omitted ?? null : k === 'content-type' && init.bytes ? 'application/octet-stream' : null),
    },
    text: async () => init.text ?? '',
    arrayBuffer: async () => init.bytes!.buffer,
  } as unknown as Response;
}

describe('fetchBody transport vs gone', () => {
  it('returns error (not gone) when the fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await fetchBody('d', 'r', 'response')).toEqual({ kind: 'error' });
  });

  it('returns error for a 5xx server failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ status: 503 })));
    expect(await fetchBody('d', 'r', 'response')).toEqual({ kind: 'error' });
  });

  it('keeps 404 as gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ status: 404 })));
    expect(await fetchBody('d', 'r', 'response')).toEqual({ kind: 'gone' });
  });

  it('keeps 410 as omitted with its reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ status: 410, omitted: 'budget' })));
    expect(await fetchBody('d', 'r', 'response')).toEqual({ kind: 'omitted', reason: 'budget' });
  });

  it('returns ok text on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ status: 200, text: 'hello' })));
    expect(await fetchBody('d', 'r', 'response')).toEqual({ kind: 'ok', text: 'hello' });
  });
});

describe('binary bodies (U4)', () => {
  it('an octet-stream body becomes base64 of its exact bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ status: 200, bytes: new Uint8Array([0, 0xff, 0xfe, 0x41]) })));
    expect(await fetchBody('d', 'r', 'response')).toEqual({ kind: 'ok', text: 'AP/+QQ==' });
    expect(await fetchFrameBody('d', 'w', 1)).toEqual({ kind: 'ok', text: 'AP/+QQ==' });
  });
});

describe('fetchFrameBody mirrors the same mapping', () => {
  it('returns error on a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await fetchFrameBody('d', 'w', 3)).toEqual({ kind: 'error' });
  });

  it('returns error on 5xx, gone on 404, omitted on 410', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ status: 500 })));
    expect(await fetchFrameBody('d', 'w', 3)).toEqual({ kind: 'error' });
    vi.stubGlobal('fetch', vi.fn(async () => res({ status: 404 })));
    expect(await fetchFrameBody('d', 'w', 3)).toEqual({ kind: 'gone' });
    vi.stubGlobal('fetch', vi.fn(async () => res({ status: 410, omitted: 'size' })));
    expect(await fetchFrameBody('d', 'w', 3)).toEqual({ kind: 'omitted', reason: 'size' });
  });
});

describe('clear throws on failure so the caller can toast', () => {
  it('rejects on a non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ status: 500 })));
    await expect(clear()).rejects.toThrow();
  });

  it('rejects on a transport error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    await expect(clear('dev-1')).rejects.toThrow();
  });

  it('resolves on 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ status: 200 })));
    await expect(clear()).resolves.toBeUndefined();
  });
});
