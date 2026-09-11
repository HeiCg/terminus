import { render, screen } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SessionList from '../SessionList.svelte';
import { Store } from '../../../lib/state/Store.svelte.js';
import { BodyCache } from '../../../lib/bodyCache.js';
import { Sockets } from '../../../lib/state/Sockets.svelte.js';
import type { WsSummary } from '../../../lib/protocol.js';

function ws(over: Partial<WsSummary> = {}): WsSummary {
  return {
    wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://example.test/ws', openedAt: 1,
    kind: 'websocket', httpEntryKey: null, closedAt: null, closeCode: null, closeReason: '',
    retainedFrames: 0, totalFrames: 0, droppedFrames: 0, partial: false, resumed: false, ...over,
  };
}

let store: Store;
let cache: BodyCache;

beforeEach(() => {
  store = new Store();
  cache = new BodyCache();
});

describe('SessionList', () => {
  it('renders the URL for a normal session', () => {
    const sockets = new Sockets({ store, cache, api: { fetchFrames: vi.fn(), fetchFrameBody: vi.fn() } });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1', url: 'wss://example.test/live' }) }]);
    render(SessionList, { props: { sockets } });
    expect(screen.getByText('wss://example.test/live')).toBeInTheDocument();
    expect(screen.queryByText('resumed')).toBeNull();
  });

  it('renders the resumed chip and the URL-unknown note for a synthesized session', () => {
    const sockets = new Sockets({ store, cache, api: { fetchFrames: vi.fn(), fetchFrameBody: vi.fn() } });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1', url: null, resumed: true }) }]);
    render(SessionList, { props: { sockets } });
    expect(screen.getByText('resumed')).toBeInTheDocument();
    expect(screen.getByText('URL unknown (opened before the collector started)')).toBeInTheDocument();
  });
});
