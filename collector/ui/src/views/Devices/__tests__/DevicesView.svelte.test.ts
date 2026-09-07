import { render, screen, fireEvent, within } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// PairingCard fetches on mount; stub the api so the view mounts without a real
// network call. Returning null lands the pairing card on its unavailable note,
// which is fine — this suite is about the device grid and counters.
vi.mock('../../../lib/api.js', () => ({
  fetchPairing: vi.fn().mockResolvedValue(null),
  clear: vi.fn().mockResolvedValue(undefined),
  exportUrl: vi.fn((k: 'har' | 'json') => (k === 'har' ? '/export.har' : '/export.json')),
}));

import DevicesView from '../DevicesView.svelte';
import { clear } from '../../../lib/api.js';
import { Store } from '../../../lib/state/Store.svelte.js';
import { Clock } from '../../../lib/state/Clock.svelte.js';
import { CTX } from '../../../lib/context.js';
import type { SnapshotMessage, EntrySummary, WsSummary, UiDevice, BodyRef } from '../../../lib/protocol.js';

const NOW = 1_700_000_000_000;
const bodyRef: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };

function entry(deviceId: string, id: string, startedAt: number): EntrySummary {
  return {
    id, deviceId, source: 'atlantis', startedAt, method: 'GET', url: 'https://api.test/x',
    status: 200, durationMs: 1, error: null, requestBody: bodyRef, responseBody: bodyRef,
  };
}

function ws(deviceId: string, wsId: string): WsSummary {
  return {
    wsId, deviceId, source: 'atlantis', url: 'wss://api.test/s', openedAt: NOW - 1000,
    kind: 'websocket', httpEntryKey: null, closedAt: null, closeCode: null, closeReason: '',
    retainedFrames: 0, totalFrames: 0, droppedFrames: 0, partial: false,
  } as WsSummary;
}

const devices: UiDevice[] = [
  { deviceId: 'iphone12abc', platform: 'ios', appVersion: '1.2.3', buildProfile: 'qa', dropped: 0, lastSeen: NOW - 5_000 },
  { deviceId: 'pixel9xyzzz', platform: 'android', appVersion: '2.0.0', buildProfile: 'dev', dropped: 3, lastSeen: NOW - 60_000 },
];

function snapshot(over: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    type: 'snapshot', devices,
    entries: { items: [entry('iphone12abc', 'a', NOW - 8000), entry('iphone12abc', 'b', NOW - 4000), entry('pixel9xyzzz', 'c', NOW - 2000)], nextCursor: null },
    ws: { items: [ws('iphone12abc', 'w1')], nextCursor: null },
    retention: { retainedBodyBytes: 2048, retainedMetadataBytes: 512, droppedEntries: 4, droppedSessions: 1, droppedFrames: 7, omittedBodies: 2, refusedSessions: 0, rejectedRecords: 0 },
    atMax: false, truncated: false, paused: false, ...over,
  };
}

function harness(snap: SnapshotMessage) {
  const store = new Store();
  store.apply([snap]);
  const clock = new Clock();
  clock.now = NOW;
  return new Map<symbol, unknown>([[CTX.store, store], [CTX.clock, clock]]);
}

beforeEach(() => {
  vi.mocked(clear).mockClear();
});

describe('DevicesView', () => {
  it('renders one card per device with the short id and live/stale state', () => {
    render(DevicesView, { context: harness(snapshot()) });
    const cards = screen.getAllByTestId('device-card');
    expect(cards.length).toBe(2);
    // Order follows the snapshot: first device is live (5 s), second stale (60 s).
    expect(cards[0].getAttribute('data-live')).toBe('true');
    expect(cards[1].getAttribute('data-live')).toBe('false');
    expect(screen.getByText('iphone')).toBeInTheDocument(); // first 6 chars of deviceId
    expect(screen.getByText('pixel9')).toBeInTheDocument();
  });

  it('shows per-device counters derived from the store', () => {
    render(DevicesView, { context: harness(snapshot()) });
    const counters = screen.getAllByTestId('device-counters');
    // Device 1: two entries, one ws, no drops.
    expect(counters[0].textContent).toContain('entries 2');
    expect(counters[0].textContent).toContain('ws 1');
    expect(counters[0].textContent).toContain('dropped 0');
    // Device 2: one entry, no ws, three drops (with a space before the number).
    expect(counters[1].textContent).toContain('entries 1');
    expect(counters[1].textContent).toContain('ws 0');
    expect(counters[1].textContent).toContain('dropped 3');
  });

  it('renders the empty state when no devices are connected', () => {
    render(DevicesView, { context: harness(snapshot({ devices: [], entries: { items: [], nextCursor: null }, ws: { items: [], nextCursor: null } })) });
    expect(screen.queryByTestId('device-card')).toBeNull();
    expect(screen.getByText('Nenhum device conectado')).toBeInTheDocument();
    expect(screen.getByText('Pareie um device usando o código ao lado.')).toBeInTheDocument();
  });

  it('always shows the retention card with dropped counters', () => {
    render(DevicesView, { context: harness(snapshot()) });
    const dropped = screen.getByTestId('retention-dropped');
    expect(dropped.textContent).toContain('dropped entries 4');
    expect(dropped.textContent).toContain('sessions 1');
    expect(dropped.textContent).toContain('frames 7');
    expect(dropped.textContent).toContain('omitted bodies 2');
  });

  it('opens a device-scoped HAR export in a throwaway tab (never a location nav)', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(DevicesView, { context: harness(snapshot()) });
    const card = screen.getAllByTestId('device-card')[1]; // pixel9xyzzz
    await fireEvent.click(within(card).getByRole('button', { name: 'Export HAR' }));
    expect(open).toHaveBeenCalledWith('/export.har?device=pixel9xyzzz');
    open.mockRestore();
  });

  it('clears a single device through the api', async () => {
    render(DevicesView, { context: harness(snapshot()) });
    const card = screen.getAllByTestId('device-card')[0]; // iphone12abc
    await fireEvent.click(within(card).getByRole('button', { name: 'Clear device' }));
    expect(vi.mocked(clear)).toHaveBeenCalledWith('iphone12abc');
  });
});
