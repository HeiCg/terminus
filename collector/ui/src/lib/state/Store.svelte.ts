import { applyUiMessages } from '../eventBuffer.js';
import { emptyUiState, type UiState } from '../state.js';
import { entityKey, type UiMessage } from '../protocol.js';

// Store wraps the pure state fold (lib/state.ts / eventBuffer.ts) in one reactive
// cell. The fold stays pure and testable; this class is the only reactive owner
// of it. `state` is `$state.raw` because the fold already returns a fresh object
// with each changed Map cloned — deep-proxying those Maps would be pure overhead,
// and the raw cell fires reactivity on reassignment, which is exactly what
// `apply` does. The `$derived` arrays are the ordered views the components read.
export class Store {
  state = $state.raw<UiState>(emptyUiState());

  // The Client sets this so v3 `paused` deltas reach the Session. They are pulled
  // out of the batch here (the pure fold treats `paused` as a no-op anyway) so
  // the fold and the pause indicator stay decoupled.
  onPaused: ((paused: boolean) => void) | null = null;

  // Plain listener list (not reactive): the Sockets view subscribes to know when
  // a batch landed so it can page freshly-grown frame counts. Fires with the
  // whole batch as received.
  private listeners = new Set<(batch: UiMessage[]) => void>();

  // Monotone count of DISTINCT HTTP arrivals seen this session — the Capture
  // autoscroll's `version`. `entries.length` cannot serve: it saturates at
  // MAX_ENTRIES once the retention cap starts evicting, so under sustained
  // traffic it stops changing and stick-to-edge/pill go inert. Only decreases on
  // a global clear/reset.
  arrivals = $state(0);

  apply(batch: UiMessage[]): void {
    if (batch.length === 0) return;
    const folded: UiMessage[] = [];
    // Fold the arrival count in message order so entries following a snapshot or
    // clear barrier accrue from that barrier's baseline, not the prior total.
    // The fold is an upsert and the collector sends `entry` TWICE per request
    // (addEntry, then patchEntryResponse), so count a key only the first time it
    // is seen — new to the store at batch start AND not yet counted in this batch.
    let next = this.arrivals;
    const seen = new Set<string>();
    for (const m of batch) {
      if (m.type === 'paused') { this.onPaused?.(m.paused); continue; }
      if (m.type === 'entry') {
        const k = entityKey(m.entry.deviceId, m.entry.id);
        if (!this.state.entries.has(k) && !seen.has(k)) { seen.add(k); next += 1; }
      } else if (m.type === 'snapshot') {
        // A snapshot is a resync, not an arrival: reset the pill baseline to zero
        // so autoscroll's decrease branch clears the backlog and re-attaches.
        next = 0;
      } else if (m.type === 'clear' && m.deviceId == null) {
        next = 0; // only a GLOBAL clear zeroes; a device-scoped clear leaves a (cosmetic) stale count
      }
      folded.push(m);
    }
    if (folded.length) this.state = applyUiMessages(this.state, folded);
    if (next !== this.arrivals) this.arrivals = next;
    for (const cb of this.listeners) cb(batch);
  }

  reset(): void { this.state = emptyUiState(); this.arrivals = 0; }

  onApplied(cb: (batch: UiMessage[]) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  entries = $derived([...this.state.entries.values()]);
  ws = $derived([...this.state.ws.values()]);
  devices = $derived([...this.state.devices.values()]);
  retention = $derived(this.state.retention);
  atMax = $derived(this.state.atMax);
  truncated = $derived(this.state.truncated);
}
