import { entityKey } from '../../../src/uiProtocol.js';
import type { UiMessage } from '../../../src/uiProtocol.js';
import { type UiState, MAX_ENTRIES, MAX_WS, evictOldest, bumpFrame } from './state.js';

// O07 — batched delta application. `applyUiMessages` folds a whole batch of server
// messages into the state in one pass, cloning each CHANGED collection at most
// once for the batch (not once per message like `applyUiMessage`). It is
// otherwise identical to `messages.reduce(applyUiMessage, state)` — same caps,
// same ordering, and snapshot/clear/removals stay hard ordering barriers (frames
// are never coalesced across them) — so the two can be compared for equality.
export function applyUiMessages(state: UiState, messages: UiMessage[]): UiState {
  if (messages.length === 0) return state;

  // Lazily clone each collection the first time it is mutated, then keep mutating
  // that owned copy for the rest of the batch.
  let devices = state.devices, entries = state.entries, ws = state.ws;
  let dCloned = false, eCloned = false, wCloned = false;
  let atMax = state.atMax, truncated = state.truncated, retention = state.retention;
  const mutD = () => { if (!dCloned) { devices = new Map(devices); dCloned = true; } return devices; };
  const mutE = () => { if (!eCloned) { entries = new Map(entries); eCloned = true; } return entries; };
  const mutW = () => { if (!wCloned) { ws = new Map(ws); wCloned = true; } return ws; };

  for (const m of messages) {
    switch (m.type) {
      case 'snapshot': {
        entries = new Map(m.entries.items.map((e) => [entityKey(e.deviceId, e.id), e] as const));
        ws = new Map(m.ws.items.map((w) => [entityKey(w.deviceId, w.wsId), w] as const));
        evictOldest(entries, MAX_ENTRIES); evictOldest(ws, MAX_WS);
        devices = new Map(m.devices.map((d) => [d.deviceId, d]));
        dCloned = eCloned = wCloned = true; // fresh maps we own
        atMax = m.atMax; truncated = m.truncated;
        retention = m.retention ?? retention; // snapshot carries totals
        break;
      }
      case 'entry': {
        const e = mutE();
        e.set(entityKey(m.entry.deviceId, m.entry.id), m.entry);
        evictOldest(e, MAX_ENTRIES);
        break;
      }
      case 'ws': {
        const w = mutW();
        w.set(entityKey(m.session.deviceId, m.session.wsId), m.session);
        evictOldest(w, MAX_WS);
        break;
      }
      case 'ws_frame': {
        const key = entityKey(m.deviceId, m.wsId);
        const existing = ws.get(key);
        if (!existing) break; // unknown session: ignore, resync fills it
        mutW().set(key, bumpFrame(existing, m));
        break;
      }
      case 'device': {
        mutD().set(m.device.deviceId, m.device);
        break;
      }
      case 'atmax':
        atMax = m.atMax;
        break;
      case 'clear': {
        if (!m.deviceId) {
          entries = new Map(); ws = new Map(); eCloned = wCloned = true; atMax = false;
        } else {
          const e = mutE(); for (const [k, v] of [...e]) if (v.deviceId === m.deviceId) e.delete(k);
          const w = mutW(); for (const [k, v] of [...w]) if (v.deviceId === m.deviceId) w.delete(k);
        }
        break;
      }
      case 'entries_removed': {
        const e = mutE();
        for (const k of m.keys) e.delete(entityKey(k.deviceId, k.id));
        break;
      }
      case 'sessions_removed': {
        const w = mutW();
        for (const k of m.keys) w.delete(entityKey(k.deviceId, k.wsId));
        break;
      }
      case 'retention': {
        const { type: _t, ...rest } = m;
        retention = rest;
        break;
      }
    }
  }

  return { devices, entries, ws, atMax, truncated, retention };
}

// Bounded staging queue between the socket and the render. Deltas accumulate here
// and are drained once per visible frame; when the queue crosses the browser
// budget (1000 events OR ~4 MiB of serialized text) it is marked overflowed, and
// the caller drops the deltas and resyncs from a fresh snapshot on reconnect
// rather than letting the queue grow without bound (esp. while a tab is hidden).
export const QUEUE_MAX_EVENTS = 1000;
export const QUEUE_MAX_BYTES = 4 * 1024 * 1024;

export class EventBuffer {
  private queue: UiMessage[] = [];
  private bytes = 0;
  overflowed = false;

  // `estBytes` is the serialized length of the raw frame (the caller has it from
  // the socket message), so the budget tracks real wire text, not object shape.
  push(m: UiMessage, estBytes: number): void {
    this.queue.push(m);
    this.bytes += estBytes;
    if (this.queue.length > QUEUE_MAX_EVENTS || this.bytes > QUEUE_MAX_BYTES) this.overflowed = true;
  }

  get length(): number { return this.queue.length; }

  // Take everything queued and reset (including the overflow flag): the caller
  // either applies the batch or, on overflow, discards it and reconnects.
  drain(): UiMessage[] {
    const q = this.queue;
    this.queue = [];
    this.bytes = 0;
    this.overflowed = false;
    return q;
  }
}
