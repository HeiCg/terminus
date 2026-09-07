import type { Store } from './Store.svelte.js';
import type { Row } from './Filters.svelte.js';
import type { BodyCache } from '../bodyCache.js';
import type { BodyState } from '../bodyState.js';
import type { BodyRef, EntryDetail, BodyOmission } from '../protocol.js';
import { entityKey } from '../protocol.js';
import { buildCurl } from '../curl.js';
import { utf8Bytes, base64ByteLength } from '../format.js';

// The two body-bearing sides of an exchange.
type Side = 'request' | 'response';
export type Tab = 'headers' | 'payload' | 'response' | 'timing' | 'curl';
// Only the two calls Selection makes are required of the api module, so tests
// inject a pair of stubs without standing up the rest of the transport.
type Api = Pick<typeof import('../api.js'), 'fetchEntryDetail' | 'fetchBody'>;

// Which body side a tab needs materialized: payload shows the request, response
// shows the response, cURL needs the request body to inline `--data-raw`.
const sideForTab = (t: Tab): Side | null =>
  t === 'payload' ? 'request' : t === 'response' ? 'response' : t === 'curl' ? 'request' : null;

// Selection is the detail panel's imperative state machine. Loading is NEVER
// reactive: `select` and `setTab` explicitly drive the fetches (detail, then the
// body the active tab needs), guarded by a monotone token so a slow response for
// a superseded selection can never overwrite the current one. Bodies flow through
// the shared BodyCache keyed by sha256, so re-selecting a row — or two rows that
// share a body hash — reuses the fetched text and its formatted representation.
export class Selection {
  #store: Store;
  #cache: BodyCache;
  #api: Api;
  // Bumped on every `select`; a resolved fetch whose token is stale is dropped.
  #token = 0;
  // Unsubscribe for the store listener; called from `dispose` when the owning
  // Capture view unmounts, so a revisit does not stack a dead listener per mount.
  #unsub: () => void;
  // In-flight `loadBody` per side, so overlapping calls (a tab reopen mid-fetch)
  // share one request instead of racing two. Stamped with the `select` token that
  // started it: a load from a superseded selection is never reused for the new
  // one (which would leave the new row stuck on `loading`).
  #pending: Record<Side, { token: number; p: Promise<void> } | null> = { request: null, response: null };

  current = $state<Row | null>(null);
  detail = $state<EntryDetail | null>(null);
  detailStatus = $state<'idle' | 'loading' | 'ok' | 'gone'>('idle');
  // entityKey → detail, shared with the CommandPalette header search (a later
  // task) so a row inspected once needs no second detail round-trip.
  detailsCache = new Map<string, EntryDetail>();
  tab = $state<Tab>('response');
  bodies = $state<{ request: BodyState; response: BodyState }>({ request: { kind: 'idle' }, response: { kind: 'idle' } });
  mode = $state<'json' | 'raw'>('json');
  panelWidth = $state(576);

  // Registered by the mounted RequestTable (via its {@attach}); the App-level
  // j/k handler calls this after a programmatic select so the newly-selected row
  // is scrolled into view even when it is unmounted under virtualization. Plain
  // (non-reactive) — it is a DOM callback registration, not render state.
  scrollToKey: ((key: string) => void) | null = null;

  constructor(deps: { store: Store; cache: BodyCache; api: Api }) {
    this.#store = deps.store;
    this.#cache = deps.cache;
    this.#api = deps.api;
    // Drop the selection when its row leaves the store (a clear or a retention
    // eviction). A store listener, not a reactive effect — the fold already knows
    // when a batch landed, and this stays a pure imperative reaction to it.
    this.#unsub = this.#store.onApplied(() => {
      const cur = this.current;
      if (cur && !this.#store.state.entries.has(entityKey(cur.deviceId, cur.id))) void this.select(null);
    });
  }

  // Release the store subscription. The Capture view calls this on unmount.
  dispose(): void {
    this.#unsub();
  }

  // Drop ALL selection state — including the detail cache — and invalidate any
  // in-flight load. Called on logout (Store.reset does not fire onApplied, so the
  // store-removal listener never runs) so a fresh session starts with no selected
  // row, no cached detail, and no body pending.
  reset(): void {
    this.#token++; // supersede any in-flight detail/body fetch
    this.current = null;
    this.detail = null;
    this.detailStatus = 'idle';
    this.detailsCache.clear();
    this.tab = 'response';
    this.bodies = { request: { kind: 'idle' }, response: { kind: 'idle' } };
    this.#pending = { request: null, response: null };
  }

  // The request body text for the cURL command: only when it is cached (ok). Uses
  // a NON-touching peek — `curl` is a $derived and must not reorder the cache LRU
  // as a side effect of rendering.
  #requestBodyText(): string | null {
    const b = this.bodies.request;
    return b.kind === 'ok' ? this.#cache.peek(b.hash) ?? null : null;
  }

  // The request body's original size when it EXISTS (a captured ref) but its text
  // is not resident — a transport failure, a 404/410 turned gone, or an eviction
  // under cache pressure. Drives the `# request body (<N> bytes) not loaded`
  // annotation so the cURL command never silently drops a real payload.
  #requestBodyNotLoadedBytes(): number | null {
    if (this.#requestBodyText() != null) return null; // resident: --data-raw wins
    const b = this.bodies.request;
    // Still loading or a truly empty/omitted body: not a "could not load" case.
    if (b.kind === 'loading' || b.kind === 'idle' || b.kind === 'absent' || b.kind === 'omitted') return null;
    const ref = this.current?.requestBody;
    if (!ref || ref.state !== 'captured') return null;
    const size = ref.size ?? ref.storedSize;
    return size > 0 ? size : null;
  }

  curl = $derived.by(() => {
    const omitted = this.bodies.request.kind === 'omitted' ? this.bodies.request.reason : undefined;
    return buildCurl(this.current, this.detail, this.#requestBodyText(), omitted, this.#requestBodyNotLoadedBytes());
  });

  async select(row: Row | null): Promise<void> {
    const token = ++this.#token;
    this.current = row;
    this.detail = null;
    this.detailStatus = row ? 'loading' : 'idle';
    this.bodies = { request: { kind: 'idle' }, response: { kind: 'idle' } };
    // Forget any load still in flight for the previous selection so this one never
    // reuses its promise (which would resolve stale and leave us on `loading`).
    this.#pending = { request: null, response: null };
    if (!row) return;

    const key = entityKey(row.deviceId, row.id);
    const detail = this.detailsCache.get(key) ?? (await this.#api.fetchEntryDetail(row.deviceId, row.id));
    if (token !== this.#token) return; // a newer selection superseded this one
    if (detail) {
      this.detailsCache.set(key, detail);
      this.detail = detail;
      this.detailStatus = 'ok';
    } else {
      this.detailStatus = 'gone';
    }

    const side = sideForTab(this.tab);
    if (side) await this.loadBody(side);
  }

  async setTab(t: Tab): Promise<void> {
    this.tab = t;
    const side = sideForTab(t);
    if (side) await this.loadBody(side);
  }

  async loadBody(side: Side): Promise<void> {
    const token = this.#token;
    // Coalesce concurrent loads of the SAME selection's side onto one promise; a
    // pending load from an older selection (different token) is never reused.
    const existing = this.#pending[side];
    if (existing && existing.token === token) return existing.p;
    const p = this.#load(side, token);
    this.#pending[side] = { token, p };
    try {
      await p;
    } finally {
      if (this.#pending[side]?.p === p) this.#pending[side] = null;
    }
  }

  async #load(side: Side, token: number): Promise<void> {
    const row = this.current;
    if (!row) return;
    const ref: BodyRef = side === 'request' ? row.requestBody : row.responseBody;

    if (ref.state === 'absent') { this.#setBody(side, { kind: 'absent' }); return; }
    if (ref.state === 'omitted') {
      this.#setBody(side, { kind: 'omitted', reason: ref.omitted ?? 'not-captured', size: ref.size ?? 0 });
      return;
    }

    // captured, but with no hash to fetch or cache by: the bytes are unreachable,
    // so surface `gone` rather than publishing an `ok` with an empty hash (which
    // would render a blank body through the cache).
    const hash = ref.sha256;
    if (!hash) { this.#setBody(side, { kind: 'gone' }); return; }

    // reuse the cached text when this hash is already resident.
    if (this.#cache.has(hash)) {
      this.#setBody(side, { kind: 'ok', hash, size: ref.size ?? ref.storedSize, encoding: ref.encoding });
      return;
    }

    this.#setBody(side, { kind: 'loading' });
    // Catch here so a rejected fetch shared across coalesced awaiters resolves to
    // a retryable `error` rather than surfacing as an unhandled rejection (the api
    // helpers already swallow transport errors; this is the belt-and-braces guard).
    let res: Awaited<ReturnType<Api['fetchBody']>>;
    try {
      res = await this.#api.fetchBody(row.deviceId, row.id, side);
    } catch {
      res = { kind: 'error' };
    }
    if (token !== this.#token || this.current !== row) return; // stale selection
    if (res.kind === 'ok') {
      this.#cache.putRaw(hash, res.text);
      // Fall back to the body's REAL byte size when the server sent none: decoded
      // bytes for a base64 (binary) body, UTF-8 bytes for text — never the UTF-16
      // string length, which over-counts multibyte text and mis-counts base64.
      const bytes = ref.encoding === 'binary' ? base64ByteLength(res.text) : utf8Bytes(res.text);
      this.#setBody(side, { kind: 'ok', hash, size: ref.size ?? bytes, encoding: ref.encoding });
    } else if (res.kind === 'omitted') {
      this.#setBody(side, { kind: 'omitted', reason: res.reason as BodyOmission, size: ref.size ?? 0 });
    } else if (res.kind === 'error') {
      // A transport/5xx failure: recoverable, so the tab offers a Retry (which
      // calls loadBody again). Distinct from a 404, which stays `gone`.
      this.#setBody(side, { kind: 'error' });
    } else {
      this.#setBody(side, { kind: 'gone' });
    }
  }

  // Replace one side; a fresh object so the $state assignment fires reactivity.
  #setBody(side: Side, s: BodyState): void {
    this.bodies = { ...this.bodies, [side]: s };
  }
}
