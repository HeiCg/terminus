import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The api module is mocked so the Pause click asserts the call, not the network.
vi.mock('../../lib/api.js', () => ({
  setPaused: vi.fn().mockResolvedValue(true),
  clear: vi.fn().mockResolvedValue(undefined),
  exportUrl: vi.fn((k: 'har' | 'json') => (k === 'har' ? '/export.har' : '/export.json')),
}));

import Topbar from '../Topbar.svelte';
import { setPaused, clear } from '../../lib/api.js';
import { Store } from '../../lib/state/Store.svelte.js';
import { Session } from '../../lib/state/Session.svelte.js';
import { Clock } from '../../lib/state/Clock.svelte.js';
import { Filters } from '../../lib/state/Filters.svelte.js';

function harness() {
  const store = new Store();
  const session = new Session();
  const clock = new Clock();
  const filters = new Filters(store);
  return { store, session, clock, filters };
}

beforeEach(() => {
  vi.mocked(setPaused).mockClear();
  vi.mocked(clear).mockClear();
});

describe('Topbar', () => {
  it('pauses via the api on click', async () => {
    const { store, session, clock, filters } = harness();
    render(Topbar, { props: { filters, session, store, clock } });
    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(vi.mocked(setPaused)).toHaveBeenCalledWith(true);
  });

  it('surfaces an inline error when setPaused rejects (no unhandled rejection)', async () => {
    const { store, session, clock, filters } = harness();
    vi.mocked(setPaused).mockRejectedValueOnce(new Error('pause 500'));
    render(Topbar, { props: { filters, session, store, clock } });
    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('Failed to pause')).toBeInTheDocument();
    expect(session.paused).toBe(false); // prior state kept, not optimistically flipped
  });

  it('clears the current device scope', async () => {
    const { store, session, clock, filters } = harness();
    filters.device = 'all';
    render(Topbar, { props: { filters, session, store, clock } });
    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(vi.mocked(clear)).toHaveBeenCalledWith(undefined);
  });

  it('handles a rejected clear() (no unhandled rejection): warns and shows an inline error', async () => {
    const { store, session, clock, filters } = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(clear).mockRejectedValueOnce(new Error('clear 500'));
    render(Topbar, { props: { filters, session, store, clock } });
    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(await screen.findByText('Failed to clear')).toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('exposes the search input by testid', () => {
    const { store, session, clock, filters } = harness();
    render(Topbar, { props: { filters, session, store, clock } });
    expect(screen.getByTestId('search')).toBeInTheDocument();
  });

  it('opens the export menu with HAR and JSON items', async () => {
    const { store, session, clock, filters } = harness();
    render(Topbar, { props: { filters, session, store, clock } });
    await fireEvent.click(screen.getByRole('button', { name: 'Export ▾' }));
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export HAR' })).toBeInTheDocument();
  });

  const pointerdown = async (el: Element): Promise<void> => {
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await tick();
  };

  it('keeps the menu open on a pointerdown inside it, closes on one outside', async () => {
    const { store, session, clock, filters } = harness();
    render(Topbar, { props: { filters, session, store, clock } });
    await fireEvent.click(screen.getByRole('button', { name: 'Export ▾' }));
    await pointerdown(screen.getByRole('button', { name: 'Export JSON' }));
    expect(screen.queryByRole('button', { name: 'Export JSON' })).toBeInTheDocument(); // inside: stays open
    await pointerdown(document.body);
    expect(screen.queryByRole('button', { name: 'Export JSON' })).toBeNull(); // outside: closed
  });

  it('trigger pointerdown then click toggles the menu closed (no reopen)', async () => {
    const { store, session, clock, filters } = harness();
    render(Topbar, { props: { filters, session, store, clock } });
    const trigger = screen.getByRole('button', { name: 'Export ▾' });
    await fireEvent.click(trigger); // open
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeInTheDocument();
    await pointerdown(trigger);     // ignored (inside the trigger) — must not pre-close
    await fireEvent.click(trigger); // toggles closed, and stays closed
    expect(screen.queryByRole('button', { name: 'Export JSON' })).toBeNull();
  });
});
