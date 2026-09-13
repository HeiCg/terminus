import type { EntryKey } from './types.js';

// Retention budgets (R6). Every axis of the store is bounded, and crossing a
// bound evicts oldest-first with a counted reason. Overridable so a test can
// drive each boundary with a tiny budget instead of 20k records.
export type RetentionLimits = {
  bodyBytes: number;        // total retained body bytes (BodyStore budget)
  perBodyBytes: number;     // max bytes retained for one HTTP body
  perWsMessageBytes: number;// max bytes retained for one WS frame payload
  metadataBytes: number;    // total metadata budget, counted by UTF-8 serialization
  maxRecordBytes: number;   // an individual metadata record above this is rejected
  httpPerDevice: number;
  httpGlobal: number;
  wsSessionsPerDevice: number;
  wsSessionsGlobal: number;
  wsMessagesPerSession: number;
  wsMessagesGlobal: number;
  admissionIdsPerGeneration: number; // session-admission registry, per connection
  admissionBytes: number;            // registry budget, counted inside metadataBytes
  // Floor for body-budget eviction: when a new body does not fit the shared body
  // budget, the store evicts oldest retained entries to free room, but never below
  // this many retained entries — so a single oversized capture can never wipe the
  // recent window to make space for itself.
  bodyEvictionFloor: number;
};

export const DEFAULT_LIMITS: RetentionLimits = {
  bodyBytes: 64 * 1024 * 1024,
  perBodyBytes: 1 * 1024 * 1024,
  perWsMessageBytes: 256 * 1024,
  metadataBytes: 32 * 1024 * 1024,
  maxRecordBytes: 64 * 1024,
  httpPerDevice: 5000,
  httpGlobal: 20000,
  wsSessionsPerDevice: 100,
  wsSessionsGlobal: 500,
  wsMessagesPerSession: 2000,
  wsMessagesGlobal: 20000,
  admissionIdsPerGeneration: 4096,
  admissionBytes: 1 * 1024 * 1024,
  bodyEvictionFloor: 100,
};

// UTF-8 serialized size of a record's metadata — the currency of the 32 MiB
// metadata budget. Body bytes live in the BodyStore's separate budget and must
// not be double-counted here, so callers pass the record already stripped of
// text bodies (a StoredEntry carries body references, not text).
export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

// A sort key: a numeric primary (a timestamp) with two string tiebreakers
// (deviceId, id), compared lexicographically. Equal timestamps and out-of-order
// arrivals therefore still get a total, stable order.
export type SortKey = readonly [number, string, string];

export function compareSortKey(a: SortKey, b: SortKey): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

type IndexNode = { sk: SortKey; key: EntryKey };

// A bounded, ordered vector of composite keys (O03). Queries by cursor are a
// binary search plus a walk to the page limit — never entries().sort().slice()
// per page. Insertion and removal are O(N) splices into the sorted vector, which
// the brief accepts as sufficient: O(log N + page) query, O(N) mutation, no
// promise of O(1) for the whole store.
export class SortedKeyIndex {
  private nodes: IndexNode[] = [];

  private lowerBound(sk: SortKey): number {
    let lo = 0, hi = this.nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareSortKey(this.nodes[mid].sk, sk) < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  insert(sk: SortKey, key: EntryKey): void {
    const pos = this.lowerBound(sk);
    this.nodes.splice(pos, 0, { sk, key });
  }

  remove(sk: SortKey): void {
    const pos = this.lowerBound(sk);
    if (pos < this.nodes.length && compareSortKey(this.nodes[pos].sk, sk) === 0) {
      this.nodes.splice(pos, 1);
    }
  }

  size(): number { return this.nodes.length; }

  // A page of keys strictly after `cursor` (or from the start when null), up to
  // `limit`. Returns the keys and the next cursor (null when exhausted).
  page(cursor: SortKey | null, limit: number): { keys: EntryKey[]; nextCursor: SortKey | null } {
    let start = 0;
    if (cursor) {
      // First node strictly greater than the cursor.
      let lo = 0, hi = this.nodes.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareSortKey(this.nodes[mid].sk, cursor) <= 0) lo = mid + 1; else hi = mid;
      }
      start = lo;
    }
    const end = Math.min(start + limit, this.nodes.length);
    const keys = this.nodes.slice(start, end).map((n) => n.key);
    const nextCursor = end < this.nodes.length ? this.nodes[end - 1].sk : null;
    return { keys, nextCursor };
  }

  clear(): void { this.nodes = []; }
}
