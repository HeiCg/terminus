import type { WsKey } from './types.js';
import { DEFAULT_LIMITS, type RetentionLimits } from './retention.js';

// Authority over which WebSocket sessions the store admits (O04). The decision
// lives here, under the store's ownership, instead of a per-socket `wsCreated`
// Set that could not survive a clear or tell a genuine reopen from a late frame.
//
// The registry of admitted / removed ids is kept SEPARATE from the session
// objects and is identified by connection generation, so:
//   - an `ws_open` (or handshake traffic) opens a session;
//   - the first orphan frame may open a session marked `partial` (a gap);
//   - an id removed by clear/eviction in a generation NEVER reopens from a late
//     frame on that same generation;
//   - a reconnect is a new generation, and a session that was not retained but
//     reappears is `partial` — it signals a gap, not a clean open.
// Every part of the registry is BOUNDED and counted against the metadata budget:
// per-generation admitted ids (≤ admissionIdsPerGeneration), per-generation
// tombstones (bounded by that generation's admitted set), and the cross-generation
// `removedEver` recency set (bounded by count AND bytes, FIFO-evicted). Nothing
// grows without a ceiling, so a long capture with unbounded session churn cannot
// accumulate tombstones forever.
export type AdmissionOutcome = 'existing' | 'new' | 'partial' | 'dropped' | 'overload';
export type AdmissionEvent = 'open' | 'frame';

const keyStr = (k: WsKey): string => JSON.stringify([k.deviceId, k.wsId]);
const cost = (ks: string): number => Buffer.byteLength(ks, 'utf8');

type Generation = { admitted: Set<string>; removed: Set<string>; bytes: number };

export interface SessionAdmission {
  observe(key: WsKey, generation: string, event: AdmissionEvent): AdmissionOutcome;
  markRemoved(key: WsKey): void;
  closeGeneration(generation: string): void;
  resetDevice(deviceId: string): void;
  reset(): void;
  registryBytes(): number;
  stats(): { generations: number; live: number; registryBytes: number; removedEver: number; overloads: number };
}

export function createSessionAdmission(limits: RetentionLimits = DEFAULT_LIMITS): SessionAdmission {
  const gens = new Map<string, Generation>();
  const live = new Set<string>();       // keys with a currently retained session
  // Bounded FIFO recency set of keys removed at least once: a reappearance of one
  // of these is `partial` (a gap). Insertion-ordered; oldest evicted first.
  const removedEver = new Set<string>();
  let removedEverBytes = 0;
  let genBytes = 0;                     // sum of per-generation registry bytes
  let overloads = 0;

  // The `removedEver` set is capped both by id count (reuse the per-generation id
  // cap) and by a share of the registry byte budget, so tombstones never grow
  // without bound. Oldest tombstones fall out first; losing an old tombstone only
  // downgrades a would-be `partial` to `new`, never a correctness problem.
  const removedEverCap = limits.admissionIdsPerGeneration;
  const removedEverByteCap = limits.admissionBytes;
  const noteRemovedEver = (ks: string): void => {
    if (removedEver.has(ks)) return;
    removedEver.add(ks); removedEverBytes += cost(ks);
    while ((removedEver.size > removedEverCap || removedEverBytes > removedEverByteCap) && removedEver.size > 0) {
      const oldest = removedEver.values().next().value as string;
      removedEver.delete(oldest); removedEverBytes -= cost(oldest);
    }
  };

  const gen = (id: string): Generation => {
    let g = gens.get(id);
    if (!g) { g = { admitted: new Set(), removed: new Set(), bytes: 0 }; gens.set(id, g); }
    return g;
  };

  return {
    observe(key, generation, event): AdmissionOutcome {
      const ks = keyStr(key);
      const g = gen(generation);
      // A late frame after this connection already saw the id removed: dropped,
      // never recreate an unbounded queue for a session we deliberately dropped.
      if (g.removed.has(ks)) return 'dropped';
      if (live.has(ks)) {
        // Session exists. Record the id in this generation once (a reconnect that
        // resumes an id retained across the gap), charging the registry.
        if (!g.admitted.has(ks)) {
          const c = cost(ks);
          if (g.admitted.size >= limits.admissionIdsPerGeneration || genBytes + removedEverBytes + c > limits.admissionBytes) {
            overloads++; return 'overload';
          }
          g.admitted.add(ks); g.bytes += c; genBytes += c;
        }
        return 'existing';
      }
      // Admitting a (re)open. Enforce the registry caps first (per-generation id
      // count and the shared byte budget that includes the tombstone recency set).
      const c = cost(ks);
      if (g.admitted.size >= limits.admissionIdsPerGeneration || genBytes + removedEverBytes + c > limits.admissionBytes) {
        overloads++; return 'overload';
      }
      g.admitted.add(ks); g.bytes += c; genBytes += c;
      live.add(ks);
      // A clean `open` for a never-removed id is new; an orphan frame or a
      // reappearance after removal is a partial session (a gap).
      if (event === 'frame' || removedEver.has(ks)) return 'partial';
      return 'new';
    },
    markRemoved(key): void {
      const ks = keyStr(key);
      live.delete(ks);
      noteRemovedEver(ks);
      // Tombstone in every generation that admitted the id (no extra byte charge:
      // the id is already counted in that generation's admitted set, and the
      // tombstone set can only ever be a subset of it — so it is inherently
      // bounded by the per-generation id cap and freed with the generation).
      for (const g of gens.values()) if (g.admitted.has(ks)) g.removed.add(ks);
    },
    closeGeneration(generation): void {
      const g = gens.get(generation);
      if (!g) return;
      genBytes -= g.bytes;
      gens.delete(generation);
    },
    resetDevice(deviceId: string): void {
      // A per-device clear reclaims that device's admission capacity WITHOUT waiting
      // for the connection to end: drop its ids from every generation's admitted and
      // removed sets (shrinking the per-generation id budget) and from live /
      // removedEver, so new sessions on the same connection are admitted again.
      const owns = (ks: string): boolean => { try { return (JSON.parse(ks) as [string, string])[0] === deviceId; } catch { return false; } };
      for (const g of gens.values()) {
        for (const ks of [...g.admitted]) if (owns(ks)) { g.admitted.delete(ks); g.bytes -= cost(ks); genBytes -= cost(ks); }
        for (const ks of [...g.removed]) if (owns(ks)) g.removed.delete(ks);
      }
      for (const ks of [...live]) if (owns(ks)) live.delete(ks);
      for (const ks of [...removedEver]) if (owns(ks)) { removedEver.delete(ks); removedEverBytes -= cost(ks); }
    },
    reset(): void {
      gens.clear(); live.clear(); removedEver.clear();
      removedEverBytes = 0; genBytes = 0;
    },
    registryBytes(): number { return genBytes + removedEverBytes; },
    stats() { return { generations: gens.size, live: live.size, registryBytes: genBytes + removedEverBytes, removedEver: removedEver.size, overloads }; },
  };
}
