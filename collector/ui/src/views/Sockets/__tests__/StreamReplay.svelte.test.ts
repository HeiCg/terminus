import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import StreamReplayButton from '../StreamReplayButton.svelte';
import FrameTimeline from '../FrameTimeline.svelte';
import SessionList from '../SessionList.svelte';
import { Store } from '../../../lib/state/Store.svelte.js';
import { BodyCache } from '../../../lib/bodyCache.js';
import { Sockets } from '../../../lib/state/Sockets.svelte.js';
import { CTX } from '../../../lib/context.js';
import type { WsSummary, FrameSummary, BodyRef } from '../../../lib/protocol.js';

// U7: raw TCP/TLS stream sessions in the Sockets view: kind badge, stream
// metadata, hex rendering of every frame, and the "Replay stream" editor.

const ref = (sha: string, size: number): BodyRef => ({ state: 'captured', sha256: sha, size, storedSize: size, encoding: 'utf8', omitted: null });
const fr = (sequence: number, direction: 'in' | 'out'): FrameSummary => ({ sequence, ts: sequence, direction, binary: false, body: ref(`h${sequence}`, 4) });

function stream(over: Partial<WsSummary> = {}): WsSummary {
  return {
    wsId: 't1', deviceId: 'd1', source: 'proxy', url: 'tcp://10.0.0.5:6379', openedAt: 1,
    kind: 'tcp', httpEntryKey: null, closedAt: 5, closeCode: null, closeReason: 'closed',
    retainedFrames: 2, totalFrames: 2, droppedFrames: 0, partial: false, resumed: false,
    stream: { host: '10.0.0.5', port: 6379, sni: null, plaintext: true }, ...over,
  };
}

const stubApi = () => ({
  fetchFrames: vi.fn(async () => ({ items: [fr(0, 'out'), fr(1, 'in')], nextCursor: null })),
  fetchFrameBody: vi.fn(async () => ({ kind: 'ok' as const, text: 'PING' })),
});

let store: Store;
let cache: BodyCache;
beforeEach(() => { store = new Store(); cache = new BodyCache(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Sockets view: raw streams', () => {
  it('lists stream sessions with their kind badge and filters TCP / TLS', async () => {
    const sockets = new Sockets({ store, cache, api: stubApi() });
    store.apply([
      { type: 'ws', session: stream() },
      { type: 'ws', session: stream({ wsId: 'p1', kind: 'tls', url: 'tls://pinned.test:443', stream: { host: 'pinned.test', port: 443, sni: 'pinned.test', plaintext: false } }) },
    ]);
    render(SessionList, { props: { sockets } });
    expect(screen.getByTestId('ws-row-t1')).toHaveTextContent('TCP');
    expect(screen.getByTestId('ws-row-p1')).toHaveTextContent('TLS');
    expect(screen.getByTestId('ws-row-p1')).toHaveTextContent('metadata only');
    await fireEvent.click(screen.getByRole('button', { name: 'TLS' }));
    expect(screen.queryByTestId('ws-row-t1')).toBeNull();
    expect(screen.getByTestId('ws-row-p1')).toBeInTheDocument();
  });

  it('shows the stream metadata, renders a text frame as hex and offers Replay stream', async () => {
    const api = stubApi();
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'ws', session: stream() }]);
    await sockets.select('t1');
    render(FrameTimeline, { props: { sockets }, context: new Map<symbol, unknown>([[CTX.cache, cache]]) });
    expect(screen.getByTestId('stream-meta')).toHaveTextContent('10.0.0.5:6379 · plain TCP');
    expect(screen.getByRole('button', { name: 'Replay stream' })).toBeEnabled();
    await fireEvent.click(screen.getByTestId('ws-frame-0'));
    const hex = await screen.findByTestId('frame-body-hex');
    expect(hex).toHaveTextContent('50 49 4e 47');
  });

  it('a pass-through tunnel cannot be replayed', async () => {
    render(StreamReplayButton, { props: { session: stream({ kind: 'tls', stream: { host: 'p.test', port: 443, sni: 'p.test', plaintext: false } }), onsent: vi.fn(), api: stubApi() } });
    expect(screen.getByRole('button', { name: 'Replay stream' })).toBeDisabled();
  });

  it('the editor lists client frames, sends the selection and hands back the new key', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string));
      return { ok: true, json: async () => ({ key: { deviceId: 'd1', wsId: 'replay-9' }, bytesSent: 4, bytesReceived: 6, durationMs: 3, closedBy: 'timeout', error: null, stored: true }), text: async () => '' } as unknown as Response;
    }));
    const onsent = vi.fn();
    const api = stubApi();
    api.fetchFrames.mockResolvedValue({ items: [fr(0, 'out'), fr(1, 'in'), fr(2, 'out')], nextCursor: null });
    render(StreamReplayButton, { props: { session: stream(), onsent, api } });
    await fireEvent.click(screen.getByRole('button', { name: 'Replay stream' }));
    expect(await screen.findByTestId('stream-replay-editor')).toBeInTheDocument();
    expect(await screen.findByLabelText('Send frame #2')).toBeChecked();
    expect(screen.queryByLabelText('Send frame #1')).toBeNull(); // server frames are not sent
    await fireEvent.click(screen.getByLabelText('Send frame #2'));
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByTestId('stream-replay-result')).toHaveTextContent('closed by timeout · sent 4 B · received 6 B');
    expect(sent[0]).toEqual({ deviceId: 'd1', wsId: 't1', timeoutMs: 10000, frames: [0] });
    expect(onsent).toHaveBeenCalledWith({ deviceId: 'd1', wsId: 'replay-9' });
  });

  it('Edit bytes opens the hex editor on the captured frame bytes', async () => {
    const api = stubApi();
    render(StreamReplayButton, { props: { session: stream(), onsent: vi.fn(), api } });
    await fireEvent.click(screen.getByRole('button', { name: 'Replay stream' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Edit bytes' }));
    expect(await screen.findByText('Frame #0 bytes (4 bytes)')).toBeInTheDocument();
    expect(screen.getByText('edited')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(screen.queryByText('edited')).toBeNull();
  });
});
