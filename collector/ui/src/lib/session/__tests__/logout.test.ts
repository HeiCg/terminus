import { describe, it, expect, vi } from 'vitest';
import { teardownOnLogout } from '../logout.js';
import { Store } from '../../state/Store.svelte.js';
import { BodyCache } from '../../bodyCache.js';
import { Selection } from '../../state/Selection.svelte.js';
import { Sockets } from '../../state/Sockets.svelte.js';
import type { Client } from '../../ws/Client.svelte.js';
import type { BodyRef, EntrySummary, WsSummary } from '../../protocol.js';

const absent: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };
const captured = (sha: string): BodyRef => ({ state: 'captured', sha256: sha, size: 10, storedSize: 10, encoding: 'utf8', omitted: null });

const entry: EntrySummary = {
  id: 'r1', deviceId: 'd1', source: 'atlantis', startedAt: 1, method: 'GET',
  url: 'https://api.test/thing', status: 200, durationMs: 3, error: null,
  requestBody: absent, responseBody: captured('resp-hash'),
};

const ws: WsSummary = {
  wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://api.test/ws', openedAt: 1,
  kind: 'websocket', httpEntryKey: null, retainedFrames: 0, totalFrames: 0,
  droppedFrames: 0, partial: false, closedAt: null, closeCode: null, closeReason: '',
} as WsSummary;

function detailApi() {
  return {
    fetchEntryDetail: vi.fn(async () => ({
      ...entry, requestHeaders: {}, responseHeaders: {}, statusText: 'OK',
    })),
    fetchBody: vi.fn(async () => ({ kind: 'ok', text: '{"ok":true}' }) as const),
    fetchFrames: vi.fn(async () => ({ items: [], nextCursor: null })),
    fetchFrameBody: vi.fn(async () => ({ kind: 'gone' }) as const),
  };
}

describe('teardownOnLogout', () => {
  it('disconnects the client and wipes store, cache, selection and sockets', async () => {
    const store = new Store();
    const cache = new BodyCache();
    const api = detailApi();
    const selection = new Selection({ store, cache, api });
    const sockets = new Sockets({ store, cache, api });

    // Seed live session state.
    store.apply([{ type: 'entry', entry }, { type: 'ws', session: ws }]);
    cache.putRaw('resp-hash', '{"ok":true}');
    await selection.select({ ...entry, kind: 'xhr', host: 'api.test', path: '/thing', bucket: '2xx', size: 10 });
    sockets.selectedId = 'w1';

    expect(store.entries.length).toBe(1);
    expect(selection.current).not.toBeNull();
    expect(selection.detail).not.toBeNull();
    expect(cache.retainedBytes).toBeGreaterThan(0);

    const disconnect = vi.fn();
    const client = { disconnect } as unknown as Client;

    teardownOnLogout({ client, store, cache, selection, sockets });

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(store.entries.length).toBe(0);
    expect(store.arrivals).toBe(0);
    expect(cache.retainedBytes).toBe(0);
    expect(selection.current).toBeNull();
    expect(selection.detail).toBeNull();
    expect(selection.detailStatus).toBe('idle');
    expect(selection.detailsCache.size).toBe(0);
    expect(sockets.selectedId).toBeNull();
    expect(sockets.frames.length).toBe(0);
  });
});
