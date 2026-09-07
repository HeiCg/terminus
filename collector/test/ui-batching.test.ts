import { describe, it, expect } from 'vitest';
import { entityKey } from '../src/uiProtocol.js';
import type { EntrySummary, WsSummary, FrameSummary, BodyRef, UiMessage } from '../src/uiProtocol.js';
import { applyUiMessage, emptyUiState, MAX_ENTRIES, type UiState } from '../ui/src/lib/state.js';
import { applyUiMessages, EventBuffer, QUEUE_MAX_EVENTS } from '../ui/src/lib/eventBuffer.js';

const ABSENT: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };
const entry = (id: string, deviceId: string, over: Partial<EntrySummary> = {}): EntrySummary => ({
  id, deviceId, source: 'xhr', startedAt: 1, method: 'GET', url: `https://x/${id}`,
  status: 200, durationMs: 1, error: null, requestBody: ABSENT, responseBody: ABSENT, ...over,
});
const ws = (wsId: string, deviceId: string, over: Partial<WsSummary> = {}): WsSummary => ({
  wsId, deviceId, source: 'xhr', url: `wss://x/${wsId}`, openedAt: 1, kind: 'websocket', httpEntryKey: null,
  closedAt: null, closeCode: null, closeReason: '', retainedFrames: 0, totalFrames: 0, droppedFrames: 0, partial: false, ...over,
});
const frame = (seq: number): FrameSummary => ({ sequence: seq, ts: seq, direction: 'in', binary: false, body: ABSENT });
// A ws_frame delta carrying the server's authoritative counts. `cap` simulates a
// per-session retention cap: once total exceeds it, retained stays at the cap and
// the surplus is counted as dropped (so the client never drifts above the server).
const wsf = (wsId: string, deviceId: string, seq: number, cap = Infinity): UiMessage => {
  const total = seq + 1;
  const retained = Math.min(total, cap);
  return { type: 'ws_frame', wsId, deviceId, frame: frame(seq), retainedFrames: retained, totalFrames: total, droppedFrames: total - retained };
};

// Fold a batch two ways: message-by-message and in one pass. They must agree.
function assertEqual(initial: UiState, messages: UiMessage[]) {
  const expected = messages.reduce(applyUiMessage, initial);
  expect(applyUiMessages(initial, messages)).toEqual(expected);
}

describe('applyUiMessages equals a per-message reduce (O07)', () => {
  it('agrees across entries, sessions, frames, clear, removal and snapshot barriers', () => {
    const initial = emptyUiState();
    // initial and messages are synthetic fixtures, including clear/removal.
    const messages: UiMessage[] = [
      { type: 'device', device: { deviceId: 'd1', platform: 'ios', appVersion: '1', buildProfile: 'qa', dropped: 0, lastSeen: 1 } },
      { type: 'entry', entry: entry('a', 'd1') },
      { type: 'entry', entry: entry('b', 'd1') },
      { type: 'ws', session: ws('w1', 'd1') },
      wsf('w1', 'd1', 1),
      wsf('w1', 'd1', 2),
      wsf('unknown', 'd1', 3), // dropped: unknown session
      { type: 'entry', entry: entry('a', 'd1', { status: 404 }) }, // update in place
      { type: 'entries_removed', keys: [{ deviceId: 'd1', id: 'b' }] },
      { type: 'entry', entry: entry('c', 'd2') },
      { type: 'clear', deviceId: 'd2' }, // partial clear barrier
      { type: 'retention', retainedBodyBytes: 1, retainedMetadataBytes: 2, droppedEntries: 1, droppedSessions: 0, droppedFrames: 1, omittedBodies: 0, refusedSessions: 0, rejectedRecords: 0 },
      { type: 'atmax', atMax: true },
      { type: 'snapshot', devices: [], entries: { items: [entry('z', 'd1')], nextCursor: null }, ws: { items: [ws('w9', 'd1', { totalFrames: 1, retainedFrames: 1 })], nextCursor: null }, retention: null, atMax: false, truncated: true, paused: false }, // barrier
      { type: 'entry', entry: entry('after', 'd1') },
    ];
    assertEqual(initial, messages);

    // The batched result reflects the barriers: only post-snapshot state remains.
    const state = applyUiMessages(initial, messages);
    expect([...state.entries.keys()]).toEqual([entityKey('d1', 'z'), entityKey('d1', 'after')]);
    expect(state.truncated).toBe(true);
    expect(state.retention?.droppedFrames).toBe(1); // totals persist across snapshot
  });

  it('coalesces a burst into one pass, cloning each changed collection once, with identical caps', () => {
    const initial = emptyUiState();
    const messages: UiMessage[] = [];
    for (let i = 0; i < MAX_ENTRIES + 50; i++) messages.push({ type: 'entry', entry: entry(`e${String(i).padStart(5, '0')}`, 'd1') });
    assertEqual(initial, messages);

    const state = applyUiMessages(initial, messages);
    expect(state.entries.size).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(state.entries.has(entityKey('d1', 'e00000'))).toBe(false); // oldest evicted by the cap
    expect(state.entries.has(entityKey('d1', `e${String(MAX_ENTRIES + 49).padStart(5, '0')}`))).toBe(true);
  });

  it('applies the server retention counts on ws_frame deltas (no upward drift)', () => {
    const initial = applyUiMessage(emptyUiState(), { type: 'ws', session: ws('w1', 'd1') });
    const messages: UiMessage[] = [];
    // Server retains at most 200 frames per session; 500 arrive.
    for (let i = 0; i < 500; i++) messages.push(wsf('w1', 'd1', i, 200));
    assertEqual(initial, messages);
    const s = applyUiMessages(initial, messages).ws.get(entityKey('d1', 'w1'))!;
    // No frame array in live state — only counts, and they match the SERVER's real
    // retention (retained pinned at the cap, drops counted), not a client drift.
    expect((s as unknown as { frames?: unknown }).frames).toBeUndefined();
    expect(s.totalFrames).toBe(500);
    expect(s.retainedFrames).toBe(200);
    expect(s.droppedFrames).toBe(300);
  });
});

describe('EventBuffer bounded staging queue', () => {
  it('marks overflow past the event budget and clears on drain', () => {
    const b = new EventBuffer();
    for (let i = 0; i <= QUEUE_MAX_EVENTS; i++) b.push({ type: 'entry', entry: entry(`e${i}`, 'd1') }, 100);
    expect(b.overflowed).toBe(true);
    const drained = b.drain();
    expect(drained.length).toBe(QUEUE_MAX_EVENTS + 1);
    expect(b.overflowed).toBe(false);
    expect(b.length).toBe(0);
  });

  it('marks overflow past the byte budget even with few events', () => {
    const b = new EventBuffer();
    b.push({ type: 'entry', entry: entry('e', 'd1') }, 5 * 1024 * 1024);
    expect(b.overflowed).toBe(true);
  });
});
