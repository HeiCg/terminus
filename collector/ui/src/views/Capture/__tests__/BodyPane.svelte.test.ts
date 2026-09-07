import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import BodyPane from '../BodyPane.svelte';
import { Store } from '../../../lib/state/Store.svelte.js';
import { BodyCache } from '../../../lib/bodyCache.js';
import { Selection } from '../../../lib/state/Selection.svelte.js';
import { CTX } from '../../../lib/context.js';
import type { Row } from '../../../lib/state/Filters.svelte.js';
import type { BodyRef, EntryDetail } from '../../../lib/protocol.js';
import type { BodyState } from '../../../lib/bodyState.js';

const absent: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'r1', deviceId: 'd1', source: 'atlantis', startedAt: 1, method: 'GET',
    url: 'https://api.test/assets/logo.png', status: 200, durationMs: 3, error: null,
    requestBody: absent, responseBody: absent,
    kind: 'xhr', host: 'api.test', path: '/assets/logo.png', bucket: '2xx', size: 20, ...over,
  };
}

// A tiny valid PNG (1x1) as base64 — the payload the cache holds for a binary body.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function makeSelection(cache: BodyCache): Selection {
  const api = {
    fetchEntryDetail: async () => null,
    fetchBody: async () => ({ kind: 'gone' }) as const,
  };
  return new Selection({ store: new Store(), cache, api });
}

function renderPane(sel: Selection, cache: BodyCache, side: 'request' | 'response' = 'response') {
  const ctx = new Map<symbol, unknown>([[CTX.cache, cache]]);
  return render(BodyPane, { props: { selection: sel, side, testid: `body-${side}` }, context: ctx });
}

function detailWith(ct: string): EntryDetail {
  return {
    ...row(), requestHeaders: {}, responseHeaders: { 'content-type': ct }, statusText: 'OK',
  } as EntryDetail;
}

describe('BodyPane binary bodies', () => {
  it('renders octet-stream as a Binary card, never as text', () => {
    const cache = new BodyCache();
    cache.putRaw('bin-hash', 'AAECAwQF'); // opaque base64 payload
    const sel = makeSelection(cache);
    sel.current = row();
    sel.detail = detailWith('application/octet-stream');
    sel.bodies = {
      request: { kind: 'absent' } as BodyState,
      response: { kind: 'ok', hash: 'bin-hash', size: 6, encoding: 'binary' } as BodyState,
    };
    renderPane(sel, cache);

    expect(screen.getByText(/Binary/)).toBeInTheDocument();
    expect(screen.getByText(/application\/octet-stream/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    // The opaque payload text is not rendered as a body.
    expect(screen.queryByText('AAECAwQF')).toBeNull();
    // No text/json body container is emitted for a binary body.
    expect(document.querySelector('pre.json')).toBeNull();
  });

  it('shows an inline <img> preview for an image body, capped at 320px', () => {
    const cache = new BodyCache();
    cache.putRaw('img-hash', PNG_B64);
    const sel = makeSelection(cache);
    sel.current = row();
    sel.detail = detailWith('image/png');
    sel.bodies = {
      request: { kind: 'absent' } as BodyState,
      response: { kind: 'ok', hash: 'img-hash', size: 68, encoding: 'binary' } as BodyState,
    };
    const { container } = renderPane(sel, cache);

    const img = container.querySelector('img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toContain('data:image/png;base64,');
    // capped at 320px (declared in the class; assert via computed inline cap marker)
    expect(container.querySelector('img.bin-preview')).not.toBeNull();
  });

  it('treats a utf8 body with a NUL byte in the first 512 as binary', () => {
    const cache = new BodyCache();
    cache.putRaw('nul-hash', 'abc' + String.fromCharCode(0) + 'def');
    const sel = makeSelection(cache);
    sel.current = row();
    sel.detail = detailWith('text/plain');
    sel.bodies = {
      request: { kind: 'absent' } as BodyState,
      response: { kind: 'ok', hash: 'nul-hash', size: 7, encoding: 'utf8' } as BodyState,
    };
    renderPane(sel, cache);
    expect(screen.getByText(/Binary/)).toBeInTheDocument();
  });

  it('renders an error card (with the side testid) and a Retry that reloads', async () => {
    const cache = new BodyCache();
    const sel = makeSelection(cache);
    const spy = vi.spyOn(sel, 'loadBody').mockResolvedValue(undefined);
    sel.current = row();
    sel.detail = detailWith('application/json');
    sel.bodies = {
      request: { kind: 'absent' } as BodyState,
      response: { kind: 'error' } as BodyState,
    };
    const { container } = renderPane(sel, cache);

    expect(container.querySelector('[data-testid="body-response"]')).not.toBeNull();
    const retry = screen.getByRole('button', { name: 'Retry' });
    await fireEvent.click(retry);
    expect(spy).toHaveBeenCalledWith('response');
  });

  it('previews an image body stored as utf8 (re-encoded to base64)', () => {
    const cache = new BodyCache();
    cache.putRaw('img-utf8', 'GIF89a raw bytes as text');
    const sel = makeSelection(cache);
    sel.current = row();
    sel.detail = detailWith('image/gif');
    sel.bodies = {
      request: { kind: 'absent' } as BodyState,
      response: { kind: 'ok', hash: 'img-utf8', size: 24, encoding: 'utf8' } as BodyState,
    };
    const { container } = renderPane(sel, cache);
    const img = container.querySelector('img.bin-preview') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toContain('data:image/gif;base64,');
  });

  it('shows an invalid-payload state when a binary body is not valid base64', () => {
    const cache = new BodyCache();
    cache.putRaw('bad-b64', '@@@not base64@@@');
    const sel = makeSelection(cache);
    sel.current = row();
    sel.detail = detailWith('application/octet-stream');
    sel.bodies = {
      request: { kind: 'absent' } as BodyState,
      response: { kind: 'ok', hash: 'bad-b64', size: 12, encoding: 'binary' } as BodyState,
    };
    renderPane(sel, cache);
    expect(screen.getByText(/Invalid payload/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });

  it('downloads a binary body with a sanitized, extension-bearing filename', async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    const RealURL = globalThis.URL;
    vi.stubGlobal('URL', Object.assign(function () {}, { createObjectURL, revokeObjectURL }));
    const appendSpy = vi.spyOn(document.body, 'appendChild');

    try {
      const cache = new BodyCache();
      cache.putRaw('dl', 'AAAA');
      const sel = makeSelection(cache);
      // A path with query and unsafe characters, and no extension on the segment.
      sel.current = row({ path: '/exports/weird name!?token=abc' });
      sel.detail = detailWith('application/pdf');
      sel.bodies = {
        request: { kind: 'absent' } as BodyState,
        response: { kind: 'ok', hash: 'dl', size: 3, encoding: 'binary' } as BodyState,
      };
      renderPane(sel, cache);
      await fireEvent.click(screen.getByRole('button', { name: 'Download' }));

      const anchor = appendSpy.mock.calls
        .map((c) => c[0] as HTMLElement)
        .find((el) => el instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined;
      expect(anchor).toBeDefined();
      expect(anchor?.download).toBe('weird_name_.pdf');
      expect(createObjectURL).toHaveBeenCalled();
      vi.runAllTimers(); // flush the deferred revoke while the stub is still live
      expect(revokeObjectURL).toHaveBeenCalled();
    } finally {
      vi.stubGlobal('URL', RealURL);
      vi.useRealTimers();
    }
  });

  it('still renders a textual JSON body as text', () => {
    const cache = new BodyCache();
    cache.putRaw('json-hash', '{"ok":true}');
    const sel = makeSelection(cache);
    sel.current = row();
    sel.detail = detailWith('application/json');
    sel.bodies = {
      request: { kind: 'absent' } as BodyState,
      response: { kind: 'ok', hash: 'json-hash', size: 11, encoding: 'utf8' } as BodyState,
    };
    const { container } = renderPane(sel, cache);
    expect(container.querySelector('[data-testid="body-response"]')).not.toBeNull();
    expect(screen.queryByText(/Binary/)).toBeNull();
  });
});
