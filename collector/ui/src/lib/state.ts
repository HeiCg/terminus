import { entityKey } from '../../../src/uiProtocol.js';
import type { Device, EntrySummary, WsSummary, UiMessage, RetentionMessage } from '../../../src/uiProtocol.js';

// Retention totals the last `retention` message reported. Kept so the UI can show
// how much was retained and DISTINGUISH refused sessions (admission said no) from
// evicted ones (`droppedSessions`).
export type RetentionState = Omit<RetentionMessage, 'type'>;

// Browser-side retention caps (T09): the live state is bounded independently of
// the server so a long session never grows it without limit. The newest records
// win — evicting by Map insertion order drops the oldest first. A reconnect
// snapshot resyncs whatever these caps trimmed.
export const MAX_ENTRIES = 2000;
export const MAX_WS = 500;
// Retained frames for the SELECTED session's on-demand frame list (app-side).
export const MAX_FRAMES = 200;

// The live UI state, keyed by composite identity so ids never collide across
// devices or sources. Entries/sessions are SUMMARIES (BodyRef, no body text; WS
// carries frame COUNTS, not the frame array) — the socket never ships body bytes,
// and bodies/frame payloads are fetched on demand. `truncated` records that the
// last snapshot dropped its oldest records to fit under the message cap.
export type UiState = {
  devices: Map<string, Device>;
  entries: Map<string, EntrySummary>;
  ws: Map<string, WsSummary>;
  atMax: boolean;
  truncated: boolean;
  retention: RetentionState | null;
};

export const emptyUiState = (): UiState =>
  ({ devices: new Map(), entries: new Map(), ws: new Map(), atMax: false, truncated: false, retention: null });

// Evict oldest (insertion order) until the map is within `max`. Mutates in place.
export function evictOldest<K, V>(m: Map<K, V>, max: number): void {
  while (m.size > max) {
    const oldest = m.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

// Apply a frame delta's authoritative counts to a session summary. Frames are
// fetched on demand (not stored in live state), so a delta only carries the
// server's current counts — including any eviction that just trimmed the oldest,
// so the client's retained count never drifts past the server's.
export function bumpFrame(s: WsSummary, counts: { retainedFrames: number; totalFrames: number; droppedFrames: number }): WsSummary {
  return { ...s, retainedFrames: counts.retainedFrames, totalFrames: counts.totalFrames, droppedFrames: counts.droppedFrames };
}

// Fold one server message into the UI state, returning a NEW state (each changed
// collection cloned once). `applyUiMessages` (eventBuffer) is the batched
// equivalent that clones once per batch; both share the caps above so their
// results are identical. Snapshot, clear and removals are ordering barriers.
export function applyUiMessage(state: UiState, m: UiMessage): UiState {
  switch (m.type) {
    case 'snapshot': {
      const entries = new Map(m.entries.items.map((e) => [entityKey(e.deviceId, e.id), e] as const));
      const ws = new Map(m.ws.items.map((w) => [entityKey(w.deviceId, w.wsId), w] as const));
      evictOldest(entries, MAX_ENTRIES); evictOldest(ws, MAX_WS);
      return {
        devices: new Map(m.devices.map((d) => [d.deviceId, d])),
        entries, ws,
        atMax: m.atMax,
        truncated: m.truncated,
        retention: m.retention ?? state.retention, // snapshot carries totals; keep prior if absent
      };
    }
    case 'entry': {
      const entries = new Map(state.entries);
      entries.set(entityKey(m.entry.deviceId, m.entry.id), m.entry);
      evictOldest(entries, MAX_ENTRIES);
      return { ...state, entries };
    }
    case 'ws': {
      const ws = new Map(state.ws);
      ws.set(entityKey(m.session.deviceId, m.session.wsId), m.session);
      evictOldest(ws, MAX_WS);
      return { ...state, ws };
    }
    case 'ws_frame': {
      const key = entityKey(m.deviceId, m.wsId);
      const session = state.ws.get(key);
      if (!session) return state; // frame for an unknown session: ignore, resync will fill it
      const ws = new Map(state.ws);
      ws.set(key, bumpFrame(session, m));
      return { ...state, ws };
    }
    case 'device': {
      const devices = new Map(state.devices);
      devices.set(m.device.deviceId, m.device);
      return { ...state, devices };
    }
    case 'atmax':
      return { ...state, atMax: m.atMax };
    case 'paused':
      // v3 pause toggle: a no-op in this pure fold (the store forwards it to the
      // Session so the UI can render the pause indicator). Kept so the switch
      // stays exhaustive over UiMessage and the state stays untouched.
      return state;
    case 'clear': {
      const dev = m.deviceId;
      if (!dev) return { ...state, entries: new Map(), ws: new Map(), atMax: false };
      const entries = new Map([...state.entries].filter(([, e]) => e.deviceId !== dev));
      const ws = new Map([...state.ws].filter(([, w]) => w.deviceId !== dev));
      return { ...state, entries, ws };
    }
    case 'entries_removed': {
      // Retention evicted these entries; drop them without a full resync.
      const entries = new Map(state.entries);
      for (const k of m.keys) entries.delete(entityKey(k.deviceId, k.id));
      return { ...state, entries };
    }
    case 'sessions_removed': {
      const ws = new Map(state.ws);
      for (const k of m.keys) ws.delete(entityKey(k.deviceId, k.wsId));
      return { ...state, ws };
    }
    case 'retention': {
      const { type: _t, ...retention } = m;
      return { ...state, retention };
    }
  }
}
