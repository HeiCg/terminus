import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import DetailPanel from '../DetailPanel.svelte';
import { Store } from '../../../lib/state/Store.svelte.js';
import { BodyCache } from '../../../lib/bodyCache.js';
import { Selection } from '../../../lib/state/Selection.svelte.js';
import { CTX } from '../../../lib/context.js';
import type { Row } from '../../../lib/state/Filters.svelte.js';
import type { BodyRef, EntryDetail } from '../../../lib/protocol.js';
import { takeRuleSeed } from '../../../lib/state/RuleDraft.svelte.js';

const absent: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };

function row(): Row {
  return {
    id: 'r1', deviceId: 'd1', source: 'atlantis', startedAt: 1, method: 'POST',
    url: 'https://api.test/thing', status: 201, durationMs: 12, error: null,
    requestBody: absent, responseBody: absent,
    kind: 'xhr', host: 'api.test', path: '/thing', bucket: '2xx', size: 20,
  };
}

const detail: EntryDetail = {
  ...row(), requestHeaders: {}, responseHeaders: { 'content-type': 'application/json' }, statusText: 'Created',
} as EntryDetail;

function makeSelection(): Selection {
  const api = { fetchEntryDetail: vi.fn(async () => detail), fetchBody: vi.fn(async () => ({ kind: 'gone' }) as const) };
  return new Selection({ store: new Store(), cache: new BodyCache(), api });
}

function renderPanel(sel: Selection) {
  const ctx = new Map<symbol, unknown>([[CTX.cache, new BodyCache()]]);
  return render(DetailPanel, { props: { selection: sel }, context: ctx });
}

describe('DetailPanel', () => {
  it('Create rule hands method/host/path of what the device sent to Settings (U6)', async () => {
    const sel = makeSelection();
    sel.current = { ...row(), method: 'PUT', url: 'https://staging.test/v2?x=1', originalMethod: 'POST', originalUrl: 'https://api.test/thing?x=1',
      rules: [{ id: 'a', name: 'To staging', action: 'rewrite', phase: 'request' }] };
    sel.detail = detail;
    sel.detailStatus = 'ok';
    const nav = { go: vi.fn() };
    render(DetailPanel, { props: { selection: sel }, context: new Map<symbol, unknown>([[CTX.cache, new BodyCache()], [CTX.nav, nav]]) });
    expect(screen.getByTestId('applied-rules')).toHaveTextContent('To staging');
    await fireEvent.click(screen.getByTestId('create-rule'));
    expect(nav.go).toHaveBeenCalledWith('settings');
    expect(takeRuleSeed()).toEqual({ method: 'POST', host: 'api.test', path: '/thing' });
  });

  it('shows no applied-rules section for an untouched entry', () => {
    const sel = makeSelection();
    sel.current = row();
    renderPanel(sel);
    expect(screen.queryByTestId('applied-rules')).toBeNull();
  });

  it('renders the header, tabs and the Copy as cURL control for a selection', () => {
    const sel = makeSelection();
    sel.current = row();
    sel.detail = detail;
    sel.detailStatus = 'ok';
    renderPanel(sel);

    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();
    expect(screen.getByText('POST')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy as cURL' })).toBeInTheDocument();
    for (const label of ['Headers', 'Payload', 'Response', 'Timing', 'cURL']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('switches the tab through the selection', async () => {
    const sel = makeSelection();
    sel.current = row();
    sel.detail = detail;
    sel.detailStatus = 'ok';
    const spy = vi.spyOn(sel, 'setTab');
    renderPanel(sel);
    await fireEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    expect(spy).toHaveBeenCalledWith('timing');
  });

  it('renders nothing when there is no selection', () => {
    const sel = makeSelection();
    sel.current = null;
    renderPanel(sel);
    expect(screen.queryByTestId('detail-panel')).toBeNull();
  });
});

describe('DetailPanel replay editor (U4)', () => {
  it('Edit… opens the editor prefilled with the captured binary body, Send navigates to the replay', async () => {
    const cache = new BodyCache();
    const bin: BodyRef = { state: 'captured', sha256: 'req-bin', size: 2, storedSize: 2, encoding: 'binary', omitted: null };
    const api = {
      fetchEntryDetail: vi.fn(async () => ({ ...detail, requestHeaders: { 'content-type': 'application/octet-stream' } })),
      fetchBody: vi.fn(async () => ({ kind: 'ok', text: 'AP8=' }) as const),
    };
    const sel = new Selection({ store: new Store(), cache, api });
    await sel.select({ ...row(), requestBody: bin });
    const focus = vi.spyOn(sel, 'focusEntry').mockImplementation(() => {});
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string));
      return { ok: true, json: async () => ({ key: { deviceId: 'd1', id: 'replay-9' }, status: 200, error: null, stripped: [] }) } as unknown as Response;
    }));
    try {
      render(DetailPanel, { props: { selection: sel }, context: new Map<symbol, unknown>([[CTX.cache, cache]]) });
      await fireEvent.click(screen.getByRole('button', { name: 'Edit…' }));
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('Edit and replay');
      expect(screen.getByRole('textbox', { name: 'URL' })).toHaveValue('https://api.test/thing');
      expect(screen.getByTestId('replay-byte-count')).toHaveTextContent('2 bytes');
      // Edit one byte in the grid, then send.
      const grid = screen.getByRole('grid');
      await fireEvent.keyDown(grid, { key: '4' });
      await fireEvent.keyDown(grid, { key: '1' });
      await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await vi.waitFor(() => expect(focus).toHaveBeenCalledWith('d1', 'replay-9'));
      expect(sent[0]).toEqual({ deviceId: 'd1', id: 'r1', credentials: 'strip', overrides: { bodyBase64: 'Qf8=' } });
      expect(screen.getByRole('status')).toHaveTextContent('sent · 200');
    } finally { vi.unstubAllGlobals(); }
  });
});
