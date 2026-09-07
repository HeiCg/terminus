import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Store } from '../Store.svelte.js';
import { BodyCache } from '../../bodyCache.js';
import { Sockets } from '../Sockets.svelte.js';
import { MAX_FRAMES } from '../../limits.js';
import type { WsSummary, FrameSummary, BodyRef, Page } from '../../protocol.js';

const captured = (sha: string, size: number): BodyRef =>
  ({ state: 'captured', sha256: sha, size, storedSize: size, encoding: 'utf8', omitted: null });

function ws(over: Partial<WsSummary> = {}): WsSummary {
  return {
    wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://example.test/ws', openedAt: 1,
    kind: 'websocket', httpEntryKey: null, closedAt: null, closeCode: null, closeReason: '',
    retainedFrames: 0, totalFrames: 0, droppedFrames: 0, partial: false, ...over,
  };
}

function frame(seq: number, over: Partial<FrameSummary> = {}): FrameSummary {
  return { sequence: seq, ts: seq, direction: 'in', binary: false, body: captured(`h${seq}`, 5), ...over };
}

const page = (items: FrameSummary[]): Page<FrameSummary> => ({ items, nextCursor: null });
const pageCur = (items: FrameSummary[], cursor: string | null): Page<FrameSummary> => ({ items, nextCursor: cursor });
const range = (start: number, count: number): FrameSummary[] => Array.from({ length: count }, (_v, i) => frame(start + i));

let store: Store;
let cache: BodyCache;

beforeEach(() => {
  store = new Store();
  cache = new BodyCache();
});

describe('Sockets — session list', () => {
  function seedSessions(): void {
    store.apply([
      { type: 'ws', session: ws({ wsId: 'a', kind: 'websocket', openedAt: 3, closedAt: null }) },
      { type: 'ws', session: ws({ wsId: 'b', kind: 'sse', openedAt: 5, closedAt: 9, closeCode: 1000 }) },
      { type: 'ws', session: ws({ wsId: 'c', kind: 'websocket', openedAt: 1, closedAt: 9, closeCode: 1006 }) },
    ]);
  }

  it('orders sessions newest first and narrows by each filter', () => {
    const api = { fetchFrames: vi.fn(), fetchFrameBody: vi.fn() };
    const sockets = new Sockets({ store, cache, api });
    seedSessions();

    expect(sockets.sessions.map((s) => s.wsId)).toEqual(['b', 'a', 'c']); // openedAt desc

    sockets.filter = 'ws';
    expect(sockets.sessions.map((s) => s.wsId)).toEqual(['a', 'c']);
    sockets.filter = 'sse';
    expect(sockets.sessions.map((s) => s.wsId)).toEqual(['b']);
    sockets.filter = 'open';
    expect(sockets.sessions.map((s) => s.wsId)).toEqual(['a']);
    sockets.filter = 'closed';
    expect(sockets.sessions.map((s) => s.wsId)).toEqual(['b', 'c']);
  });
});

describe('Sockets — frames', () => {
  it('select loads the first page ascending and resolves selected', async () => {
    const api = {
      fetchFrames: vi.fn(async () => page([frame(2), frame(0), frame(1)])),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);

    await sockets.select('w1');

    expect(api.fetchFrames).toHaveBeenCalledWith('d1', 'w1', null, 200);
    expect(sockets.frames.map((f) => f.sequence)).toEqual([0, 1, 2]); // normalized ascending
    expect(sockets.framesStatus).toBe('done');
    expect(sockets.selected?.wsId).toBe('w1');
  });

  it('opens on the newest window for a session larger than one page', async () => {
    // 250 admitted frames; the newest 200 window is sequences 50..249, reached by
    // paging from after = totalFrames - PAGE - 1 = 49.
    const api = {
      fetchFrames: vi.fn(async (_d: string, _w: string, after: number | null) =>
        page(Array.from({ length: 200 }, (_v, i) => frame((after ?? -1) + 1 + i)))),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1', totalFrames: 250, retainedFrames: 250 }) }]);

    await sockets.select('w1');

    expect(api.fetchFrames).toHaveBeenCalledWith('d1', 'w1', 49, 200);
    expect(sockets.frames[0].sequence).toBe(50);
    expect(sockets.frames[sockets.frames.length - 1].sequence).toBe(249);
    expect(sockets.atOldest).toBe(false); // older frames remain below the window
  });

  it('loadOlder prepends the strictly-older page', async () => {
    const api = {
      fetchFrames: vi.fn(async (_d: string, _w: string, after: number | null) =>
        after === null ? page([frame(5), frame(6), frame(7)]) : page([frame(2), frame(3), frame(4), frame(5)])),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);

    await sockets.select('w1');
    expect(sockets.frames.map((f) => f.sequence)).toEqual([5, 6, 7]);

    await sockets.loadOlder();
    expect(sockets.frames.map((f) => f.sequence)).toEqual([2, 3, 4, 5, 6, 7]); // older prepended, deduped
  });

  it('offers Load newer on a CLOSED session byte-capped short of the tip, and walks forward to it', async () => {
    // The first window comes back with a cursor (capped): frames 0..1 loaded but
    // 2..3 remain newer. On a closed session there is no live tail, so Load newer
    // is the way forward; its null cursor means the tip is reached and it clears.
    const api = {
      fetchFrames: vi.fn(async (_d: string, _w: string, after: number | null) =>
        after == null ? pageCur([frame(0), frame(1)], '1') : pageCur([frame(2), frame(3)], null)),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1', closedAt: 9, closeCode: 1000 }) }]);

    await sockets.select('w1');
    expect(sockets.frames.map((f) => f.sequence)).toEqual([0, 1]);
    expect(sockets.hasNewer).toBe(true);
    expect(sockets.canLoadNewer).toBe(true);

    await sockets.loadNewer();
    expect(api.fetchFrames).toHaveBeenLastCalledWith('d1', 'w1', 1, 200); // after=last shown
    expect(sockets.frames.map((f) => f.sequence)).toEqual([0, 1, 2, 3]);
    expect(sockets.hasNewer).toBe(false);
    expect(sockets.canLoadNewer).toBe(false);
  });

  it('suppresses Load newer while a live (open) session is auto-tailing (round 1)', async () => {
    // Same byte-capped short window, but the session is OPEN: the live tail owns
    // forward progress, so canLoadNewer stays false even though hasNewer is true.
    const api = {
      fetchFrames: vi.fn(async (_d: string, _w: string, after: number | null) =>
        after == null ? pageCur([frame(5), frame(6)], '6') : pageCur([frame(3), frame(4), frame(5)], null)),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]); // open (closedAt null)

    await sockets.select('w1');
    expect(sockets.hasNewer).toBe(true);
    expect(sockets.canLoadNewer).toBe(false); // live tail active → not offered

    // Once the viewport is anchored to history by loadOlder, it returns.
    await sockets.loadOlder();
    expect(sockets.canLoadNewer).toBe(true);
  });

  it('loadNewer trims to MAX_FRAMES so repeated forward paging stays bounded (round 1)', async () => {
    // Closed session: a short initial window, then each loadNewer appends 100 newer
    // frames. The window must never grow past MAX_FRAMES and stays contiguous.
    const api = {
      fetchFrames: vi.fn(async (_d: string, _w: string, after: number | null) =>
        after == null ? pageCur(range(0, 50), '49') : pageCur(range(after + 1, 100), String(after + 100))),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1', closedAt: 9, closeCode: 1000 }) }]);

    await sockets.select('w1');
    for (let n = 0; n < 6; n++) await sockets.loadNewer();

    expect(sockets.frames.length).toBeLessThanOrEqual(MAX_FRAMES);
    // The retained window is contiguous (newest MAX_FRAMES frames, oldest trimmed).
    const seqs = sockets.frames.map((f) => f.sequence);
    expect(seqs[seqs.length - 1]).toBe(seqs[0] + seqs.length - 1);
  });

  it('caps D3 auto-retry at 3 attempts ≥2s apart, then stays in error until manual Retry (round 1)', async () => {
    vi.useFakeTimers();
    const base = 1_000_000;
    vi.setSystemTime(base);
    // An always-empty page keeps a retaining session in `error` on every load.
    const api = { fetchFrames: vi.fn(async () => page([])), fetchFrameBody: vi.fn() };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1', retainedFrames: 3, totalFrames: 3 }) }]);

    await sockets.select('w1');
    expect(sockets.framesStatus).toBe('error');
    expect(api.fetchFrames).toHaveBeenCalledTimes(1);

    const settle = async (): Promise<void> => { for (let k = 0; k < 6; k++) await Promise.resolve(); };
    const liveFrame = (): void => store.apply([{ type: 'ws_frame', wsId: 'w1', deviceId: 'd1', frame: frame(1), retainedFrames: 3, totalFrames: 3, droppedFrames: 0 }]);

    liveFrame(); await settle();                       // retry 1 (immediate)
    expect(api.fetchFrames).toHaveBeenCalledTimes(2);
    liveFrame(); await settle();                       // within 2s → throttled
    expect(api.fetchFrames).toHaveBeenCalledTimes(2);
    vi.setSystemTime(base + 2000); liveFrame(); await settle(); // retry 2
    expect(api.fetchFrames).toHaveBeenCalledTimes(3);
    vi.setSystemTime(base + 4000); liveFrame(); await settle(); // retry 3
    expect(api.fetchFrames).toHaveBeenCalledTimes(4);
    vi.setSystemTime(base + 10_000); liveFrame(); await settle(); // capped → no retry
    expect(api.fetchFrames).toHaveBeenCalledTimes(4);

    // Manual Retry still attempts a load (and would reset the budget on success).
    await sockets.select('w1');
    expect(api.fetchFrames).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });

  it('jumpToLive scrolls the frame list to the live edge (round 1)', async () => {
    const api = {
      fetchFrames: vi.fn(async (_d: string, _w: string, after: number | null) =>
        after === null ? page([frame(5), frame(6)]) : page([frame(3), frame(4), frame(5)])),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);
    await sockets.select('w1');
    await sockets.loadOlder();

    const scroll = vi.fn();
    sockets.scrollToLive = scroll;
    await sockets.jumpToLive();
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('offers Jump to live after loadOlder and re-selects the newest window on jump', async () => {
    const api = {
      fetchFrames: vi.fn(async (_d: string, _w: string, after: number | null) =>
        after === null ? page([frame(5), frame(6), frame(7)]) : page([frame(2), frame(3), frame(4), frame(5)])),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);

    await sockets.select('w1');
    expect(sockets.canJumpToLive).toBe(false);

    await sockets.loadOlder();
    expect(sockets.frames.map((f) => f.sequence)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(sockets.canJumpToLive).toBe(true); // viewport anchored to history

    await sockets.jumpToLive();
    // Back on the newest window; the live tail is re-enabled (loadedOlder cleared).
    expect(sockets.frames.map((f) => f.sequence)).toEqual([5, 6, 7]);
    expect(sockets.canJumpToLive).toBe(false);
  });

  it('auto-retries a failed frame load when the next live frame arrives (D3)', async () => {
    // First load returns an empty page for a retaining session → error. A live
    // frame then arrives and the retry load succeeds.
    let call = 0;
    const api = {
      fetchFrames: vi.fn(async () => (call++ === 0 ? page([]) : page([frame(0), frame(1)]))),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1', retainedFrames: 2, totalFrames: 2 }) }]);

    await sockets.select('w1');
    expect(sockets.framesStatus).toBe('error');

    store.apply([{ type: 'ws_frame', wsId: 'w1', deviceId: 'd1', frame: frame(1), retainedFrames: 2, totalFrames: 2, droppedFrames: 0 }]);
    await vi.waitFor(() => expect(sockets.framesStatus).toBe('done'));
    expect(sockets.frames.map((f) => f.sequence)).toEqual([0, 1]);
  });

  it('toggleFrame expands and loads the body once, collapse then re-expand does not refetch', async () => {
    const api = {
      fetchFrames: vi.fn(async () => page([frame(0)])),
      fetchFrameBody: vi.fn(async () => ({ kind: 'ok', text: 'hello' }) as const),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);
    await sockets.select('w1');

    await sockets.toggleFrame(0);
    expect(sockets.expanded.has(0)).toBe(true);
    expect(sockets.bodies[0]?.kind).toBe('ok');
    expect(api.fetchFrameBody).toHaveBeenCalledTimes(1);
    expect(cache.has('h0')).toBe(true);

    await sockets.toggleFrame(0); // collapse
    expect(sockets.expanded.has(0)).toBe(false);
    await sockets.toggleFrame(0); // re-expand — cached, no second fetch
    expect(api.fetchFrameBody).toHaveBeenCalledTimes(1);
  });

  it('maps a transport failure to error and recovers via reloadFrameBody', async () => {
    const api = {
      fetchFrames: vi.fn(async () => page([frame(0)])),
      fetchFrameBody: vi.fn()
        .mockResolvedValueOnce({ kind: 'error' })
        .mockResolvedValueOnce({ kind: 'ok', text: 'recovered' }),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);
    await sockets.select('w1');

    await sockets.toggleFrame(0);
    expect(sockets.bodies[0]?.kind).toBe('error');

    await sockets.reloadFrameBody(0);
    expect(sockets.bodies[0]?.kind).toBe('ok');
    expect(api.fetchFrameBody).toHaveBeenCalledTimes(2);
  });

  it('sizes a frame body by real bytes when the ref carries no size', async () => {
    const noSize: BodyRef = { state: 'captured', sha256: 'h0', size: null, storedSize: 0, encoding: 'utf8', omitted: null };
    const api = {
      fetchFrames: vi.fn(async () => page([frame(0, { body: noSize })])),
      fetchFrameBody: vi.fn(async () => ({ kind: 'ok', text: '€€' }) as const), // 2 chars, 6 bytes
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);
    await sockets.select('w1');
    await sockets.toggleFrame(0);
    expect(sockets.bodies[0]).toMatchObject({ kind: 'ok', size: 6 });
  });

  it('reset() drops the selection, frames and bodies', async () => {
    const api = {
      fetchFrames: vi.fn(async () => page([frame(0)])),
      fetchFrameBody: vi.fn(async () => ({ kind: 'ok', text: 'x' }) as const),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);
    await sockets.select('w1');
    await sockets.toggleFrame(0);
    expect(sockets.selectedId).toBe('w1');
    expect(sockets.frames.length).toBe(1);

    sockets.reset();
    expect(sockets.selectedId).toBeNull();
    expect(sockets.frames.length).toBe(0);
    expect(sockets.bodies).toEqual({});
    expect(sockets.framesStatus).toBe('idle');
  });

  it('visibleFrames respects direction, binary, and search over cached previews', async () => {
    const api = {
      fetchFrames: vi.fn(async () => page([
        frame(0, { direction: 'in', binary: true }),
        frame(1, { direction: 'out', binary: false }),
      ])),
      fetchFrameBody: vi.fn(async () => ({ kind: 'ok', text: 'needle-in-haystack' }) as const),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);
    await sockets.select('w1');

    expect(sockets.visibleFrames.map((f) => f.sequence)).toEqual([0, 1]);

    sockets.direction = 'out';
    expect(sockets.visibleFrames.map((f) => f.sequence)).toEqual([1]);
    sockets.direction = 'all';

    sockets.binaryOnly = true;
    expect(sockets.visibleFrames.map((f) => f.sequence)).toEqual([0]);
    sockets.binaryOnly = false;

    // Search matches only frames whose body has been fetched into the cache.
    await sockets.toggleFrame(0);
    sockets.search = 'needle';
    expect(sockets.visibleFrames.map((f) => f.sequence)).toEqual([0]);
    sockets.search = 'missing';
    expect(sockets.visibleFrames).toEqual([]);
  });

  it('live-tails a new frame for the selected session onto the newest window', async () => {
    const api = {
      fetchFrames: vi.fn(async (_d: string, _w: string, after: number | null) =>
        after === null ? page([frame(0)]) : page([frame(1)])),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);
    await sockets.select('w1');
    expect(sockets.frames.map((f) => f.sequence)).toEqual([0]);

    // A frame delta for the selected session drives the tail fetch (after=last).
    store.apply([{ type: 'ws_frame', wsId: 'w1', deviceId: 'd1', frame: frame(1), retainedFrames: 2, totalFrames: 2, droppedFrames: 0 }]);
    await vi.waitFor(() => expect(sockets.frames.map((f) => f.sequence)).toEqual([0, 1]));
    expect(api.fetchFrames).toHaveBeenLastCalledWith('d1', 'w1', 0, 200);
  });

  it('re-enables loadOlder when a live tail trims the oldest off the window', async () => {
    const api = {
      fetchFrames: vi.fn(async (_d: string, _w: string, after: number | null) =>
        after == null ? page(Array.from({ length: 200 }, (_v, i) => frame(i))) : page([frame(200)])),
      fetchFrameBody: vi.fn(),
    };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1', totalFrames: 200, retainedFrames: 200 }) }]);
    await sockets.select('w1');
    expect(sockets.frames[0].sequence).toBe(0);
    expect(sockets.atOldest).toBe(true); // window starts at sequence 0
    expect(sockets.canLoadOlder).toBe(false);

    store.apply([{ type: 'ws_frame', wsId: 'w1', deviceId: 'd1', frame: frame(200), retainedFrames: 201, totalFrames: 201, droppedFrames: 0 }]);
    await vi.waitFor(() => expect(sockets.frames.at(-1)?.sequence).toBe(200));
    expect(sockets.frames[0].sequence).toBe(1); // 0 trimmed off the top by the window slice
    expect(sockets.atOldest).toBe(false);
    expect(sockets.canLoadOlder).toBe(true);
  });

  it('marks the load as error when a retaining session returns an empty page', async () => {
    const api = { fetchFrames: vi.fn(async () => page([])), fetchFrameBody: vi.fn() };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1', retainedFrames: 5, totalFrames: 5 }) }]);
    await sockets.select('w1');
    expect(sockets.framesStatus).toBe('error');
    expect(sockets.frames).toEqual([]);
  });

  it('drops the selection when its session leaves the store', async () => {
    const api = { fetchFrames: vi.fn(async () => page([frame(0)])), fetchFrameBody: vi.fn() };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);
    await sockets.select('w1');
    expect(sockets.selectedId).toBe('w1');

    store.apply([{ type: 'clear', deviceId: null }]);
    expect(sockets.selectedId).toBe(null);
    expect(sockets.frames).toEqual([]);
  });

  it('drops a store subscription on dispose', async () => {
    const api = { fetchFrames: vi.fn(async () => page([frame(0)])), fetchFrameBody: vi.fn() };
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: ws({ wsId: 'w1' }) }]);
    await sockets.select('w1');
    sockets.dispose();

    // After dispose no tail fetch fires for a further frame delta.
    api.fetchFrames.mockClear();
    store.apply([{ type: 'ws_frame', wsId: 'w1', deviceId: 'd1', frame: frame(1), retainedFrames: 2, totalFrames: 2, droppedFrames: 0 }]);
    await Promise.resolve();
    expect(api.fetchFrames).not.toHaveBeenCalled();
  });
});
