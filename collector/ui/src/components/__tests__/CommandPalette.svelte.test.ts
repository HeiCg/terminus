import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import CommandPalette from '../CommandPalette.svelte';
import { Store } from '../../lib/state/Store.svelte.js';
import { Filters } from '../../lib/state/Filters.svelte.js';
import { Selection } from '../../lib/state/Selection.svelte.js';
import { BodyCache } from '../../lib/bodyCache.js';
import type { SnapshotMessage, EntrySummary, BodyRef } from '../../lib/protocol.js';

const absent: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };
const captured = (sha256: string, size: number): BodyRef => ({ state: 'captured', sha256, size, storedSize: size, encoding: 'utf8', omitted: null });

function entry(over: Partial<EntrySummary> = {}): EntrySummary {
  return {
    id: 'r', deviceId: 'd1', source: 'atlantis', startedAt: 0, method: 'GET',
    url: 'https://api.test/thing', status: 200, durationMs: 10, error: null,
    requestBody: absent, responseBody: absent, ...over,
  };
}

function snapshot(entries: EntrySummary[]): SnapshotMessage {
  return {
    type: 'snapshot', devices: [], entries: { items: entries, nextCursor: null },
    ws: { items: [], nextCursor: null }, retention: null, atMax: false, truncated: false, paused: false,
  };
}

// A palette wired to a real Store/Filters/Selection/BodyCache — the same runtime
// objects CaptureView lifts up to App. e1 matches by url, e2 only by the text of
// its cached response body.
function harness() {
  const store = new Store();
  store.apply([
    snapshot([
      entry({ id: 'e1', url: 'https://a.test/login', method: 'POST', startedAt: 1 }),
      entry({ id: 'e2', url: 'https://a.test/data', startedAt: 2, responseBody: captured('h2', 20) }),
    ]),
  ]);
  const cache = new BodyCache();
  cache.putRaw('h2', 'super-needle-payload');
  const filters = new Filters(store);
  const selection = new Selection({ store, cache, api: { fetchEntryDetail: vi.fn(), fetchBody: vi.fn() } as never });
  return { store, cache, filters, selection };
}

function renderPalette(h = harness(), over: Record<string, unknown> = {}) {
  const onclose = vi.fn();
  const onpick = vi.fn();
  const view = render(CommandPalette, { props: { open: true, onclose, onpick, filters: h.filters, selection: h.selection, cache: h.cache, ...over } });
  return { ...h, onclose, onpick, unmount: view.unmount };
}

describe('CommandPalette', () => {
  it('lists a request that matches by url under Requests', async () => {
    renderPalette();
    await fireEvent.input(screen.getByRole('combobox'), { target: { value: 'login' } });
    // Wait out the debounce: once it settles, the non-matching /data row is gone
    // (before then, the empty query lists every row).
    await waitFor(() => expect(screen.queryByText(/\/data/)).toBeNull());
    expect(screen.getByText('Requests')).toBeInTheDocument();
    expect(screen.getByText(/login/)).toBeInTheDocument();
  });

  it('lists a request that matches only by cached body text under Bodies (loaded only)', async () => {
    renderPalette();
    await fireEvent.input(screen.getByRole('combobox'), { target: { value: 'needle' } });
    expect(await screen.findByText('Bodies (loaded only)')).toBeInTheDocument();
    expect(await screen.findByText(/\/data/)).toBeInTheDocument();
  });

  it('searches the device-scoped set even when a filter chip is active (ruling b)', async () => {
    const h = harness();
    h.filters.type = 'ws'; // hides the XHR login row from filters.rows, not from allRows
    renderPalette(h);
    await fireEvent.input(screen.getByRole('combobox'), { target: { value: 'login' } });
    expect(await screen.findByText(/login/)).toBeInTheDocument();
  });

  it('debounces: two keystrokes within the window trigger a single body scan', async () => {
    const h = harness();
    const spy = vi.spyOn(h.cache, 'peekLower');
    renderPalette(h);
    const input = screen.getByRole('combobox');
    await fireEvent.input(input, { target: { value: 'ne' } });
    await fireEvent.input(input, { target: { value: 'nee' } });
    // The Bodies group only appears once the debounced query drives a scan; its
    // presence is the barrier that the single recompute has happened.
    await screen.findByText('Bodies (loaded only)');
    // e2 is the only row with a resident body → the scan ran once, not once per keystroke.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and stops propagation so the App handler does not also run', async () => {
    const { onclose } = renderPalette();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stop = vi.spyOn(ev, 'stopPropagation');
    screen.getByRole('combobox').dispatchEvent(ev);
    expect(onclose).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it('picks the active result on Enter', async () => {
    const { onpick } = renderPalette();
    const input = screen.getByRole('combobox');
    await fireEvent.input(input, { target: { value: 'login' } });
    await screen.findByText(/login/); // wait out the debounce so a result is active
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onpick).toHaveBeenCalledTimes(1);
    expect(onpick.mock.calls[0][0].id).toBe('e1');
  });

  it('marks exactly one option aria-selected when results exist', async () => {
    renderPalette();
    // 'a.test' matches both e1 and e2 urls → more than one option.
    await fireEvent.input(screen.getByRole('combobox'), { target: { value: 'a.test' } });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(1));
    const selected = screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
  });

  it('lists the 50 NEWEST rows for an empty query and finds a match on the newest', async () => {
    const store = new Store();
    // 60 rows, startedAt 0..59; allRows is newest-first so the cap keeps 59..10.
    store.apply([
      snapshot(Array.from({ length: 60 }, (_v, i) => entry({ id: `e${i}`, url: `https://a.test/path-${i}`, startedAt: i }))),
    ]);
    const filters = new Filters(store);
    const selection = new Selection({ store, cache: new BodyCache(), api: { fetchEntryDetail: vi.fn(), fetchBody: vi.fn() } as never });
    render(CommandPalette, { props: { open: true, onclose: vi.fn(), onpick: vi.fn(), filters, selection, cache: new BodyCache() } });

    // Empty query renders immediately (no debounce): newest present, oldest cut.
    expect(screen.getByText(/\bpath-59\b/)).toBeInTheDocument();
    expect(screen.getByText(/\bpath-10\b/)).toBeInTheDocument(); // the 50th newest
    expect(screen.queryByText(/\bpath-5\b/)).toBeNull(); // startedAt 5 is in the oldest 10

    // A query matching only the newest row still finds it (break-at-50 keeps it).
    await fireEvent.input(screen.getByRole('combobox'), { target: { value: 'path-59' } });
    expect(await screen.findByText(/\bpath-59\b/)).toBeInTheDocument();
  });

  it('clears the query when the palette is reopened (D6)', async () => {
    const h = harness();
    const props = { open: true, onclose: vi.fn(), onpick: vi.fn(), filters: h.filters, selection: h.selection, cache: h.cache };
    const { rerender } = render(CommandPalette, { props });

    await fireEvent.input(screen.getByRole('combobox'), { target: { value: 'login' } });
    expect(screen.getByRole('combobox')).toHaveValue('login');

    await rerender({ ...props, open: false }); // ⌘K closes → panel unmounts
    await rerender({ ...props, open: true });  // ⌘K reopens → fresh, blank query
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('restores focus to the opener when it closes (Esc → unmount)', async () => {
    const opener = document.createElement('button');
    opener.setAttribute('data-testid', 'opener');
    document.body.appendChild(opener);
    opener.focus();

    const { onclose, unmount } = renderPalette(); // opener captured at init
    // The input grabbed focus on mount.
    expect(document.activeElement).not.toBe(opener);

    await fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onclose).toHaveBeenCalled();
    unmount(); // App unmounts the palette on close → teardown restores focus
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
