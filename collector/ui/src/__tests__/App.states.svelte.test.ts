import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import App from '../App.svelte';
import { Store } from '../lib/state/Store.svelte.js';
import { Session } from '../lib/state/Session.svelte.js';
import { Nav } from '../lib/state/Nav.svelte.js';
import { Clock } from '../lib/state/Clock.svelte.js';
import { BodyCache } from '../lib/bodyCache.js';
import { Filters } from '../lib/state/Filters.svelte.js';
import { Selection } from '../lib/state/Selection.svelte.js';
import { Sockets } from '../lib/state/Sockets.svelte.js';
import * as api from '../lib/api.js';
import { rootContext } from '../lib/context.js';
import type { SnapshotMessage, EntrySummary, BodyRef } from '../lib/protocol.js';

const absent: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };

function entry(over: Partial<EntrySummary> = {}): EntrySummary {
  return {
    id: 'r', deviceId: 'd1', source: 'atlantis', startedAt: 0, method: 'GET',
    url: 'https://a.test/keep', status: 200, durationMs: 10, error: null,
    requestBody: absent, responseBody: absent, ...over,
  };
}

function snapshot(entries: EntrySummary[]): SnapshotMessage {
  return {
    type: 'snapshot', devices: [], entries: { items: entries, nextCursor: null },
    ws: { items: [], nextCursor: null }, retention: null, atMax: false, truncated: false, paused: false,
  };
}

function renderApp() {
  const session = new Session();
  session.status = 'ready'; // past boot: the shell renders (not the login screen)
  const store = new Store();
  const cache = new BodyCache();
  const nav = new Nav();
  const filters = new Filters(store);
  const selection = new Selection({ store, cache, api });
  const sockets = new Sockets({ store, cache, api, filters });
  const context = rootContext({ store, session, nav, clock: new Clock(), cache, filters, selection, sockets });
  const { container } = render(App, { context });
  return { session, store, nav, filters, selection, container };
}

const modK = (): boolean =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, metaKey: true, bubbles: true }));

const esc = (): boolean =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

describe('App connection + pause states', () => {
  it('shows the reconnecting banner and dims main while reconnecting', async () => {
    const { session, container } = renderApp();
    session.connection = 'reconnecting';
    session.reconnectAttempt = 3;
    await tick();
    expect(screen.getByText(/Reconectando ao collector… tentativa 3/)).toBeInTheDocument();
    expect(container.querySelector('main')?.classList.contains('dim')).toBe(true);
  });

  it('marks the shell paused after a paused message', async () => {
    const { session, container } = renderApp();
    expect(container.querySelector('.paused')).toBeNull();
    session.paused = true; // what a `paused` delta sets via Store.onPaused → session
    await tick();
    expect(container.querySelector('.paused')).not.toBeNull();
  });
});

describe('App hotkeys + command palette', () => {
  it('opens the palette on ⌘K dispatched at window level (nothing focused)', async () => {
    renderApp();
    await tick();
    modK();
    await tick();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('Escape in the open palette closes it WITHOUT clearing the table selection', async () => {
    const { store } = renderApp();
    store.apply([snapshot([entry({ id: 'x1', url: 'https://a.test/keep' })])]);
    await tick();

    // Select the first row with `j` (dispatched on body → window-bound hotkey).
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    await tick();
    await tick();
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();

    modK();
    await tick();
    // Escape on the palette input (named to disambiguate from the topbar/filter
    // <select>s, which also carry the combobox role): the palette closes and
    // stops propagation, so the App-root escape handler never runs select(null).
    await fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search commands' }), { key: 'Escape' });
    await tick();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();
  });
});

describe('App Escape is scoped to the active view (D7)', () => {
  it('clears the selection on Escape while on Capture', async () => {
    const { store, nav, filters, selection } = renderApp();
    store.apply([snapshot([entry({ id: 'x1' })])]);
    await tick();
    await selection.select(filters.rows[0]);
    await tick();
    expect(selection.current?.id).toBe('x1');
    expect(nav.view).toBe('capture');

    esc();
    await tick();
    expect(selection.current).toBeNull();
  });

  it('does NOT clear the (invisible) Capture selection on Escape while on Sockets', async () => {
    const { store, nav, filters, selection } = renderApp();
    store.apply([snapshot([entry({ id: 'x1' })])]);
    await tick();
    await selection.select(filters.rows[0]);
    await tick();
    expect(selection.current?.id).toBe('x1');

    nav.go('sockets');
    await tick();
    esc();
    await tick();
    // Escape on Sockets is not "clear the Capture selection" — it survives.
    expect(selection.current?.id).toBe('x1');
  });
});

describe('App view state is app-lifetime (survives tab switches)', () => {
  it('preserves an active filter and the selection across devices → capture', async () => {
    const { store, nav, filters, selection } = renderApp();
    store.apply([snapshot([entry({ id: 'x1', url: 'https://a.test/keep' })])]);
    await tick();

    filters.toggleStatus('2xx');      // a chip that would be discarded by a per-view rebuild
    await selection.select(filters.rows[0]); // detail fetch rejects in jsdom → current still set
    await tick();
    expect(selection.current?.id).toBe('x1');

    nav.go('devices');
    await tick();
    nav.go('capture');
    await tick();

    // The singletons kept their state — no per-mount Filters/Selection was rebuilt.
    expect(filters.statuses.has('2xx')).toBe(true);
    expect(selection.current?.id).toBe('x1');
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();
  });
});

// Relative-URL body/detail fetches reject in jsdom; the api helpers swallow them,
// but silence the noise so the run stays clean.
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in jsdom'); }));
