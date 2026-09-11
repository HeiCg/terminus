import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import FrameTimeline from '../FrameTimeline.svelte';
import { Store } from '../../../lib/state/Store.svelte.js';
import { BodyCache } from '../../../lib/bodyCache.js';
import { Sockets } from '../../../lib/state/Sockets.svelte.js';
import { CTX } from '../../../lib/context.js';
import type { WsSummary, FrameSummary, BodyRef, Page } from '../../../lib/protocol.js';

const captured = (sha: string, size: number): BodyRef =>
  ({ state: 'captured', sha256: sha, size, storedSize: size, encoding: 'utf8', omitted: null });

function ws(over: Partial<WsSummary> = {}): WsSummary {
  return {
    wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://example.test/ws', openedAt: 1,
    kind: 'websocket', httpEntryKey: null, closedAt: null, closeCode: null, closeReason: '',
    retainedFrames: 0, totalFrames: 0, droppedFrames: 0, partial: false, resumed: false, ...over,
  };
}

function frame(seq: number, over: Partial<FrameSummary> = {}): FrameSummary {
  return { sequence: seq, ts: seq, direction: 'in', binary: false, body: captured(`h${seq}`, 5), ...over };
}

const page = (items: FrameSummary[]): Page<FrameSummary> => ({ items, nextCursor: null });
const pageCur = (items: FrameSummary[], cursor: string | null): Page<FrameSummary> => ({ items, nextCursor: cursor });

let store: Store;
let cache: BodyCache;

beforeEach(() => {
  store = new Store();
  cache = new BodyCache();
});

function renderTimeline(sockets: Sockets) {
  return render(FrameTimeline, {
    props: { sockets },
    context: new Map<symbol, unknown>([[CTX.cache, cache]]),
  });
}

describe('FrameTimeline', () => {
  it('shows the empty prompt with no session selected', () => {
    const api = { fetchFrames: vi.fn(), fetchFrameBody: vi.fn() };
    renderTimeline(new Sockets({ store, cache, api }));
    expect(screen.getByText('Select a session')).toBeInTheDocument();
  });

  it('renders frame rows for the selected session and loads a body on expand', async () => {
    const api = {
      fetchFrames: vi.fn(async () => page([frame(0), frame(1)])),
      fetchFrameBody: vi.fn(async () => ({ kind: 'ok', text: 'fixture-frame' }) as const),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1', url: 'wss://example.test/ws' }) }]);
    await sockets.select('w1');

    renderTimeline(sockets);

    expect(screen.getByTestId('ws-frame-0')).toBeInTheDocument();
    expect(screen.getByTestId('ws-frame-1')).toBeInTheDocument();

    await fireEvent.click(screen.getByTestId('ws-frame-0'));
    expect(await screen.findByTestId('frame-body-text')).toHaveTextContent('fixture-frame');
  });

  it('exposes list semantics: role=list container with a listitem per frame (D2)', async () => {
    const api = {
      fetchFrames: vi.fn(async () => page([frame(0), frame(1), frame(2)])),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);
    await sockets.select('w1');

    renderTimeline(sockets);

    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('shows Load newer in the toolbar when a closed window is short of the tip, and pulls the next page (D1)', async () => {
    const api = {
      fetchFrames: vi.fn(async (_d: string, _w: string, after: number | null) =>
        after == null ? pageCur([frame(0), frame(1)], '1') : pageCur([frame(2)], null)),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    // Closed session so Load newer is offered (an open one auto-tails instead).
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1', closedAt: 9, closeCode: 1000 }) }]);
    await sockets.select('w1');

    renderTimeline(sockets);

    const loadNewer = screen.getByRole('button', { name: 'Load newer' });
    await fireEvent.click(loadNewer);
    expect(await screen.findByTestId('ws-frame-2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load newer' })).toBeNull();
  });

  it('shows Jump to live only after older frames are paged in (D1)', async () => {
    const api = {
      fetchFrames: vi.fn(async (_d: string, _w: string, after: number | null) =>
        after === null ? page([frame(5), frame(6)]) : page([frame(3), frame(4), frame(5)])),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);
    await sockets.select('w1');

    renderTimeline(sockets);
    expect(screen.queryByRole('button', { name: 'Jump to live' })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByTestId('ws-frame-3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Jump to live' })).toBeInTheDocument();
  });

  it('renders the resumed chip and the "URL unknown" note for a synthesized session', async () => {
    const api = {
      fetchFrames: vi.fn(async () => page([frame(0)])),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1', url: null, resumed: true }) }]);
    await sockets.select('w1');

    renderTimeline(sockets);

    expect(screen.getByText('resumed')).toBeInTheDocument();
    expect(screen.getByText('URL unknown (opened before the collector started)')).toBeInTheDocument();
  });

  it('renders the direction toolbar and disables Load older at the first page', async () => {
    const api = {
      fetchFrames: vi.fn(async () => page([frame(0)])), // sequence 0 → oldest reached
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);
    await sockets.select('w1');

    renderTimeline(sockets);

    expect(screen.getByRole('radio', { name: '↓ In' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load older' })).toBeDisabled();
  });
});
