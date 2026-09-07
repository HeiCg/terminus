import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import DetailPanel from '../DetailPanel.svelte';
import { Store } from '../../../lib/state/Store.svelte.js';
import { BodyCache } from '../../../lib/bodyCache.js';
import { Selection } from '../../../lib/state/Selection.svelte.js';
import { CTX } from '../../../lib/context.js';
import type { Row } from '../../../lib/state/Filters.svelte.js';
import type { BodyRef, EntryDetail } from '../../../lib/protocol.js';

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
