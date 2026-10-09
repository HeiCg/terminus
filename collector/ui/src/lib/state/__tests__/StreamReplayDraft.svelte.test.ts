import { describe, it, expect, vi } from 'vitest';
import { StreamReplayDraft } from '../StreamReplayDraft.svelte.js';
import type { WsSummary, FrameSummary, BodyRef } from '../../protocol.js';

const ref = (size: number, encoding: 'utf8' | 'binary' = 'utf8'): BodyRef =>
  ({ state: 'captured', sha256: `h${size}`, size, storedSize: size, encoding, omitted: null });
const fr = (sequence: number, direction: 'in' | 'out', body: BodyRef = ref(3)): FrameSummary =>
  ({ sequence, ts: sequence, direction, binary: body.encoding === 'binary', body });

function session(over: Partial<WsSummary> = {}): WsSummary {
  return {
    wsId: 'w1', deviceId: 'd1', source: 'proxy', url: 'tcp://10.0.0.5:6379', openedAt: 1,
    kind: 'tcp', httpEntryKey: null, closedAt: 2, closeCode: null, closeReason: 'closed',
    retainedFrames: 4, totalFrames: 4, droppedFrames: 0, partial: false, resumed: false,
    stream: { host: '10.0.0.5', port: 6379, sni: null, plaintext: true }, ...over,
  };
}

// Two pages: the client frames are 0, 2 (page 1) and 4 (page 2); 4 is binary.
function api() {
  const bodies: Record<number, string> = { 0: 'one', 2: 'two', 4: 'AP8=' };
  return {
    fetchFrames: vi.fn(async (_d: string, _w: string, after: number | null) => after == null
      ? { items: [fr(0, 'out'), fr(1, 'in'), fr(2, 'out')], nextCursor: '2' }
      : { items: [fr(3, 'in'), fr(4, 'out', ref(2, 'binary'))], nextCursor: null }),
    fetchFrameBody: vi.fn(async (_d: string, _w: string, seq: number) => ({ kind: 'ok' as const, text: bodies[seq] })),
  };
}

function okFetch(response: Record<string, unknown> = {}) {
  const sent: unknown[] = [];
  const f = vi.fn(async (_u: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string));
    return {
      ok: true,
      json: async () => ({ key: { deviceId: 'd1', wsId: 'replay-1' }, bytesSent: 3, bytesReceived: 5, durationMs: 9, closedBy: 'server', error: null, stored: true, ...response }),
      text: async () => '',
    } as unknown as Response;
  });
  return { f: f as unknown as typeof fetch, sent };
}

describe('StreamReplayDraft', () => {
  it('lists every client frame across pages and selects them all', async () => {
    const a = api();
    const d = new StreamReplayDraft(session(), a);
    await d.load();
    expect(d.loadStatus).toBe('done');
    expect(d.frames.map((f) => f.sequence)).toEqual([0, 2, 4]);
    expect([...d.selected]).toEqual([0, 2, 4]);
    expect(a.fetchFrames.mock.calls.map((c) => c[2])).toEqual([null, 2]);
  });

  it('prefills the connection from the capture and sends only what changed', async () => {
    const d = new StreamReplayDraft(session(), api());
    await d.load();
    expect([d.tls, d.host, d.port, d.sni]).toEqual([false, '10.0.0.5', '6379', '']);
    expect(await d.request()).toEqual({ deviceId: 'd1', wsId: 'w1', timeoutMs: 10000 });
    d.toggle(2);
    d.tls = true; d.sni = 'redis.test'; d.port = '6380'; d.timeoutMs = '500';
    expect(await d.request()).toEqual({ deviceId: 'd1', wsId: 'w1', tls: true, sni: 'redis.test', port: 6380, timeoutMs: 500, frames: [0, 4] });
    d.port = '70000';
    expect(await d.request()).toMatch(/port/);
    d.port = '6379'; d.timeoutMs = '40000';
    expect(await d.request()).toMatch(/timeout/);
  });

  it('a TLS capture defaults to TLS with its SNI', () => {
    const d = new StreamReplayDraft(session({ kind: 'tls', stream: { host: 'h.test', port: 443, sni: 'h.test', plaintext: true } }), api());
    expect([d.tls, d.sni]).toEqual([true, 'h.test']);
  });

  it('an edited frame sends overrides for every selected frame (captured bytes for the rest)', async () => {
    const d = new StreamReplayDraft(session(), api());
    await d.load();
    await d.edit(2);
    expect(d.editing).toBe(2);
    const buf = d.edits.get(2)!;
    expect(Array.from(buf.bytes)).toEqual([0x74, 0x77, 0x6f]); // "two"
    buf.replaceAll(new Uint8Array([0xde, 0xad]));
    const p = await d.request();
    expect(p).toMatchObject({ overrides: { framesBase64: [btoa('one'), btoa('\xde\xad'), 'AP8='] } });
    expect((p as { frames?: number[] }).frames).toBeUndefined();
    d.revert(2);
    expect(d.editing).toBeNull();
    expect((await d.request() as { overrides?: unknown }).overrides).toBeUndefined();
  });

  it('posts the draft and reports the outcome; an error surfaces the server message', async () => {
    const d = new StreamReplayDraft(session(), api());
    await d.load();
    const { f, sent } = okFetch();
    expect(await d.send(f)).toEqual({ deviceId: 'd1', wsId: 'replay-1' });
    expect(sent[0]).toEqual({ deviceId: 'd1', wsId: 'w1', timeoutMs: 10000 });
    expect(d.phase).toBe('done');
    expect(d.message).toBe('closed by server · sent 3 B · received 5 B');
    const bad = vi.fn(async () => ({ ok: false, status: 422, text: async () => '{"error":"this is a TLS pass-through tunnel"}' }) as unknown as Response);
    expect(await d.send(bad as unknown as typeof fetch)).toBeNull();
    expect(d.phase).toBe('error');
    expect(d.message).toBe('this is a TLS pass-through tunnel');
  });
});
