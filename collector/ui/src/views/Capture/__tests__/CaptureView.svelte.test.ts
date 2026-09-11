import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import CaptureView from '../CaptureView.svelte';
import { Store } from '../../../lib/state/Store.svelte.js';
import { Filters } from '../../../lib/state/Filters.svelte.js';
import { Nav } from '../../../lib/state/Nav.svelte.js';
import { CTX } from '../../../lib/context.js';
import type { SnapshotMessage, EntrySummary, BodyRef } from '../../../lib/protocol.js';

const NOW = 1_700_000_000_000;
const bodyRef: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };

function entry(deviceId: string, id: string): EntrySummary {
  return {
    id, deviceId, source: 'atlantis', startedAt: NOW - 1000, method: 'GET', url: 'https://api.test/x',
    status: 200, durationMs: 1, error: null, requestBody: bodyRef, responseBody: bodyRef,
  };
}

function snapshot(entries: EntrySummary[]): SnapshotMessage {
  return {
    type: 'snapshot', devices: [],
    entries: { items: entries, nextCursor: null },
    ws: { items: [], nextCursor: null },
    retention: null, atMax: false, truncated: false, paused: false,
  };
}

// CaptureView reads store/nav/filters/selection from context. Selection is stubbed
// (the detail panel and table never mount in the empty-device branch), so only a
// null `current` is needed.
function harness(store: Store, filters: Filters) {
  const selection = { current: null } as unknown;
  return new Map<symbol, unknown>([
    [CTX.store, store], [CTX.nav, new Nav()], [CTX.filters, filters], [CTX.selection, selection],
  ]);
}

describe('CaptureView empty states', () => {
  it('shows the cross-device hint when the selected device has no entries', () => {
    const store = new Store();
    store.apply([snapshot([entry('other-device', 'a')])]); // traffic exists, but under another id
    const filters = new Filters(store);
    filters.device = 'phone-under-two-ids';

    render(CaptureView, { context: harness(store, filters) });

    expect(screen.getByText('No requests on this device yet.')).toBeInTheDocument();
    expect(
      screen.getByText('Traffic from this phone may be arriving under another device id — switch to All devices.'),
    ).toBeInTheDocument();
  });

  it('the All devices button resets the device filter', async () => {
    const store = new Store();
    store.apply([snapshot([entry('other-device', 'a')])]);
    const filters = new Filters(store);
    filters.device = 'phone-under-two-ids';

    render(CaptureView, { context: harness(store, filters) });
    await fireEvent.click(screen.getByRole('button', { name: 'All devices' }));
    expect(filters.device).toBe('all');
  });

  it('shows the waiting state when there are no entries at all', () => {
    const store = new Store();
    store.apply([snapshot([])]);
    const filters = new Filters(store);
    render(CaptureView, { context: harness(store, filters) });
    expect(screen.getByText('Aguardando device…')).toBeInTheDocument();
  });
});
