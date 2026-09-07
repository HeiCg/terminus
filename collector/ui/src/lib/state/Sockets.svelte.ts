import { SvelteSet } from 'svelte/reactivity';
import type { Store } from './Store.svelte.js';
import type { BodyCache } from '../bodyCache.js';
import type { BodyState } from '../bodyState.js';
import type { WsSummary, FrameSummary, BodyRef, BodyOmission, UiMessage } from '../protocol.js';
import { MAX_FRAMES } from '../limits.js';
import { utf8Bytes, base64ByteLength } from '../format.js';

// One frame page, and the size of the live window the UI keeps in memory. The
// server retains far more per session (~2000) and pages ascending by `sequence`,
// so this is NOT the whole history — `select` pages to the newest window and
// `loadOlder` walks backwards from there; the live tail trims back to this size.
const PAGE = MAX_FRAMES;
// A one-line row preview never renders more than this many characters, and the
// frame search matches against the same clipped slice.
const PREVIEW_CHARS = 120;
// D3 auto-retry after a failed frame load: at most this many consecutive automatic
// retries, each at least this far apart, before the pane stays in `error` until a
// manual Retry. A success resets the counter.
const MAX_AUTO_RETRIES = 3;
const RETRY_MIN_INTERVAL_MS = 2000;

// Only the two frame calls Sockets makes are required of the api module, so tests
// inject a pair of stubs without standing up the rest of the transport.
type Api = Pick<typeof import('../api.js'), 'fetchFrames' | 'fetchFrameBody'>;
// Just the device scope Sockets needs from Filters (the Topbar device switcher
// scopes the Sockets list too). Optional so unit tests can stand Sockets up alone.
type DeviceScope = { device: string | 'all' };
export type SessionFilter = 'all' | 'ws' | 'sse' | 'open' | 'closed';
export type FrameDirection = 'all' | 'in' | 'out';

// Sockets is the WS/SSE inspector's imperative state machine, the frame-list twin
// of Selection. Frame loading is NEVER reactive: `select`/`loadOlder`/`toggleFrame`
// drive the fetches explicitly, guarded by a monotone token so a slow response for
// a superseded session can never overwrite the current one. Frame payloads flow
// through the shared BodyCache keyed by sha256, so a frame expanded once — or two
// frames sharing a body hash — reuse the fetched text and its formatting. Live
// tailing rides the Store's `onApplied` hook, never a reactive effect.
export class Sockets {
  #store: Store;
  #cache: BodyCache;
  #api: Api;
  // The shared device scope (Topbar switcher). Read reactively in `sessions`, so a
  // device change re-narrows the list; absent in standalone unit tests → no scope.
  #filters?: DeviceScope;
  // Bumped on every `select`; a resolved fetch whose token is stale is dropped.
  #token = 0;
  // Unsubscribe for the store listener; called from `dispose` when the owning view
  // unmounts, so a revisit does not stack a dead listener per mount.
  #unsub: () => void;
  // Coalesce concurrent live-tail fetches onto one in-flight request.
  #tailing = false;
  // Once the user pages older frames, stop auto-tailing to the newest edge — the
  // viewport is anchored to history, not the live tip. Reactive so the timeline's
  // "Jump to live" affordance (`canJumpToLive`) tracks it.
  #loadedOlder = $state(false);
  // A frame that arrived while the initial page was still in flight was skipped by
  // the tail guard; this remembers to catch up once the page settles so the pane
  // lands on the true newest window, never one frame behind.
  #tailPending = false;
  // D3 auto-retry accounting: consecutive automatic retries since the last success
  // and the wall-clock of the most recent one, to cap and throttle the retries.
  #autoRetries = 0;
  #lastAutoRetryAt = 0;

  // Scroll the frame list to the live edge. The FrameTimeline view registers this
  // (it owns the scroll container); `jumpToLive` calls it after the window swaps.
  // A plain callback, not reactive state — it is DOM plumbing, not view data.
  scrollToLive: (() => void) | null = null;

  filter = $state<SessionFilter>('all');
  selectedId = $state<string | null>(null);
  frames = $state<FrameSummary[]>([]);
  framesStatus = $state<'idle' | 'loading' | 'done' | 'error'>('idle');
  // True when the oldest retained frame is already shown, so `loadOlder` has
  // nothing left to fetch and the toolbar button disables.
  atOldest = $state(false);
  // True when the loaded window does NOT reach the newest retained frame — the page
  // came back short of the live tip (cut by PAGE_MAX_BYTES or PAGE_MAX_RECORDS, so
  // `nextCursor` was set). Feeds "Load newer", but only in anchored-history mode:
  // while a live session auto-tails, the tail closes the gap (see `canLoadNewer`).
  hasNewer = $state(false);
  direction = $state<FrameDirection>('all');
  binaryOnly = $state(false);
  search = $state('');
  expanded = new SvelteSet<number>();
  bodies = $state<Record<number, BodyState>>({});

  constructor(deps: { store: Store; cache: BodyCache; api: Api; filters?: DeviceScope }) {
    this.#store = deps.store;
    this.#cache = deps.cache;
    this.#api = deps.api;
    this.#filters = deps.filters;
    // Live tail + drop-on-removal ride the batch hook, not a reactive effect: the
    // fold already knows when a batch landed and this stays a pure reaction to it.
    this.#unsub = this.#store.onApplied((batch) => this.#onBatch(batch));
  }

  // Release the store subscription. The owning view calls this on unmount.
  dispose(): void {
    this.#unsub();
  }

  // Drop ALL socket-inspector state and invalidate any in-flight frame load.
  // Called on logout (Store.reset does not fire onApplied, so #onBatch never runs
  // to clear the selection) so a fresh session starts with no selected session,
  // no frames, and no bodies.
  reset(): void {
    this.#token++; // supersede any in-flight frame/body fetch
    this.selectedId = null;
    this.frames = [];
    this.expanded.clear();
    this.bodies = {};
    this.framesStatus = 'idle';
    this.#loadedOlder = false;
    this.#tailPending = false;
    this.#tailing = false;
    this.atOldest = false;
  }

  // Sessions for the list column: newest first (openedAt desc), narrowed by the
  // active filter chip. Reads the Store's `$derived` ws array, so it recomputes
  // whenever a batch lands or the filter changes — no effect required.
  sessions = $derived.by((): WsSummary[] => {
    const f = this.filter;
    // The Topbar device switcher scopes this list too: when a specific device is
    // picked, only its sessions show; 'all' (or no shared scope) shows every one.
    const device = this.#filters?.device ?? 'all';
    const rows = this.#store.ws.filter((s) => {
      if (device !== 'all' && s.deviceId !== device) return false;
      switch (f) {
        case 'ws': return s.kind === 'websocket';
        case 'sse': return s.kind === 'sse';
        case 'open': return s.closedAt == null;
        case 'closed': return s.closedAt != null;
        default: return true;
      }
    });
    return [...rows].sort((a, b) => b.openedAt - a.openedAt);
  });

  // The selected session, or null when its id is unset or the session has left the
  // store. Frame fetches read `deviceId` from here.
  selected = $derived.by((): WsSummary | null => this.#store.ws.find((s) => s.wsId === this.selectedId) ?? null);

  // The loaded frames narrowed by direction/binary and, when a query is present,
  // by a substring match over each frame's cached text preview (only frames whose
  // body has been fetched carry a preview to match). Reads `bodies` so a preview
  // that arrives after the query is set refreshes the result.
  visibleFrames = $derived.by((): FrameSummary[] => {
    const q = this.search.trim().toLowerCase();
    const bodies = this.bodies; // dependency: refresh matches as frame bodies cache
    return this.frames.filter((fr) => {
      if (this.direction !== 'all' && fr.direction !== this.direction) return false;
      if (this.binaryOnly && !fr.binary) return false;
      if (q) {
        const text = this.#previewFrom(fr, bodies);
        if (text == null || !text.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  });

  // True when there is an older page left to fetch and a session is loaded.
  canLoadOlder = $derived(this.framesStatus === 'done' && this.frames.length > 0 && !this.atOldest);

  // True when the loaded window stops short of the newest frame, so "Load newer"
  // can pull the next page forward toward the live tip — but NOT while a live (open)
  // session is auto-tailing: there the tail owns forward progress and a page cursor
  // is the record/byte cap, not a gap the user must page over. Once the viewport is
  // anchored to history (`#loadedOlder`) or the session has closed, "Load newer"
  // returns as the way to walk forward.
  canLoadNewer = $derived.by((): boolean => {
    if (this.framesStatus !== 'done' || this.frames.length === 0 || !this.hasNewer) return false;
    const liveTailing = this.selected?.closedAt == null && !this.#loadedOlder;
    return !liveTailing;
  });

  // True once the viewport has been anchored to history by `loadOlder`: the live
  // tail is suspended, so "Jump to live" is offered to snap back to the tip.
  canJumpToLive = $derived(this.framesStatus === 'done' && this.#loadedOlder);

  // First PREVIEW_CHARS of a frame's cached text, or null when its body is not an
  // `ok` cached text body. A NON-touching peek so a $derived read never reorders
  // the cache LRU as a side effect of rendering.
  #previewFrom(fr: FrameSummary, bodies: Record<number, BodyState>): string | null {
    const b = bodies[fr.sequence];
    if (!b || b.kind !== 'ok' || b.encoding !== 'utf8') return null;
    const raw = this.#cache.peek(b.hash);
    return raw == null ? null : raw.slice(0, PREVIEW_CHARS);
  }

  // Public preview for the row renderer (reads the current bodies map).
  preview(fr: FrameSummary): string | null {
    return this.#previewFrom(fr, this.bodies);
  }

  // Select a session and load its newest frame window (ascending by sequence).
  // Clears the prior frames/expansion/bodies so a stale window never bleeds across
  // sessions.
  async select(wsId: string): Promise<void> {
    // A genuine new selection (not a retry of the same session) re-arms the D3
    // auto-retry budget; a manual/auto retry of the same session keeps its count.
    if (wsId !== this.selectedId) { this.#autoRetries = 0; this.#lastAutoRetryAt = 0; }
    const token = ++this.#token;
    this.selectedId = wsId;
    this.frames = [];
    this.expanded.clear();
    this.bodies = {};
    this.#loadedOlder = false;
    this.#tailPending = false;
    this.atOldest = false;
    this.hasNewer = false;
    this.framesStatus = 'loading';

    const sel = this.#store.ws.find((s) => s.wsId === wsId);
    if (!sel) { this.framesStatus = 'error'; return; }

    // Open on the live tip: the server pages ascending from `after` and retains far
    // more than one window, so `after=null` would land on the OLDEST frames. Page
    // from just before the newest PAGE sequences instead (null when the whole
    // session already fits in one window).
    const after = sel.totalFrames > PAGE ? sel.totalFrames - PAGE - 1 : null;
    const page = await this.#api.fetchFrames(sel.deviceId, wsId, after, PAGE);
    if (token !== this.#token) return; // a newer selection superseded this one
    this.frames = this.#asc(page.items);
    // The api swallows transport errors into an empty page, so an empty result for
    // a session that reports retained frames is a failed load, not an empty
    // session — surface it as `error` (retryable) rather than a misleading "no
    // frames". A genuinely empty session (0 retained) settles as `done`.
    if (page.items.length === 0 && sel.retainedFrames > 0) {
      this.framesStatus = 'error';
      return;
    }
    this.framesStatus = 'done';
    // A successful load clears the D3 auto-retry budget.
    this.#autoRetries = 0;
    this.#lastAutoRetryAt = 0;
    this.atOldest = this.frames.length === 0 || this.frames[0].sequence === 0;
    // A cursor means the page stopped short of the newest frame (record/byte cap):
    // there are newer frames the initial window did not reach — offer "Load newer".
    this.hasNewer = page.nextCursor != null;
    // Catch up on any frame that landed while this fetch was in flight.
    if (this.#tailPending && !this.#loadedOlder) {
      this.#tailPending = false;
      const cur = this.#store.ws.find((s) => s.wsId === wsId);
      if (cur) void this.#tail(cur);
    }
  }

  // Page one window of strictly-older frames and prepend them. Disabled once the
  // oldest retained frame is already shown (`atOldest`), which also switches this
  // view off live tailing so the anchored history does not jump.
  async loadOlder(): Promise<void> {
    if (this.atOldest || this.frames.length === 0) return;
    const sel = this.selected;
    if (!sel) return;
    const token = this.#token;
    const lowest = this.frames[0].sequence;
    const page = await this.#api.fetchFrames(sel.deviceId, sel.wsId, lowest - PAGE, PAGE);
    if (token !== this.#token) return;
    const older = page.items.filter((f) => f.sequence < lowest);
    if (older.length === 0) { this.atOldest = true; return; }
    this.frames = this.#dedupeAsc([...older, ...this.frames]);
    this.#loadedOlder = true;
    if (this.frames[0].sequence === 0) this.atOldest = true;
  }

  // Page one window of strictly-newer frames and append them, walking forward from
  // the last shown sequence toward the live tip. Used when the initial window came
  // back byte-capped short of the newest frame (`hasNewer`); clears the flag once
  // the newest frame is reached (the forward page carries no further cursor).
  async loadNewer(): Promise<void> {
    // Coalesce onto the same in-flight flag the live tail uses, so a manual "Load
    // newer" and an auto tail never double-fetch the same forward page.
    if (!this.hasNewer || this.frames.length === 0 || this.#tailing) return;
    const sel = this.selected;
    if (!sel) return;
    this.#tailing = true;
    const token = this.#token;
    try {
      const last = this.frames[this.frames.length - 1].sequence;
      const page = await this.#api.fetchFrames(sel.deviceId, sel.wsId, last, PAGE);
      if (token !== this.#token) return;
      const newer = page.items.filter((f) => f.sequence > last);
      if (newer.length === 0) { this.hasNewer = false; return; }
      let merged = this.#dedupeAsc([...this.frames, ...newer]);
      // Bound memory like the tail: keep only the newest window. This can drop the
      // oldest frames off the top, so recompute `atOldest` from the new head.
      if (merged.length > MAX_FRAMES) merged = merged.slice(merged.length - MAX_FRAMES);
      this.frames = merged;
      this.hasNewer = page.nextCursor != null;
      this.atOldest = merged[0]?.sequence === 0;
    } finally {
      this.#tailing = false;
    }
  }

  // Snap back to the live tip after `loadOlder` anchored the viewport to history:
  // re-select the same session, which reloads the newest window and re-enables the
  // live tail (a user gesture, not a reactive re-run).
  async jumpToLive(): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    await this.select(id);
    // Window replaced; snap the list to the live edge. The view's registered
    // callback owns the DOM timing (it defers to a frame), so no effect here.
    this.scrollToLive?.();
  }

  // Toggle a frame's expansion; expanding loads its body through the cache once.
  async toggleFrame(seq: number): Promise<void> {
    if (this.expanded.has(seq)) { this.expanded.delete(seq); return; }
    this.expanded.add(seq);
    await this.#loadBody(seq);
  }

  // Retry a frame body that landed in the `error` state: forget the prior result
  // so #loadBody re-fetches instead of short-circuiting on the resolved entry.
  async reloadFrameBody(seq: number): Promise<void> {
    const next = { ...this.bodies };
    delete next[seq];
    this.bodies = next;
    await this.#loadBody(seq);
  }

  async #loadBody(seq: number): Promise<void> {
    // Load once: a resolved (or in-flight) body is never re-fetched on re-expand.
    if (this.bodies[seq]) return;
    const sel = this.selected;
    if (!sel) return;
    const fr = this.frames.find((f) => f.sequence === seq);
    if (!fr) return;
    const ref: BodyRef = fr.body;

    if (ref.state === 'absent') { this.#setBody(seq, { kind: 'absent' }); return; }
    if (ref.state === 'omitted') {
      this.#setBody(seq, { kind: 'omitted', reason: ref.omitted ?? 'not-captured', size: ref.size ?? 0 });
      return;
    }

    // captured, but with no hash to fetch or cache by: the bytes are unreachable,
    // so surface `gone` rather than an `ok` with an empty hash (a blank body).
    const hash = ref.sha256;
    if (!hash) { this.#setBody(seq, { kind: 'gone' }); return; }

    if (this.#cache.has(hash)) {
      this.#setBody(seq, { kind: 'ok', hash, size: ref.size ?? ref.storedSize, encoding: ref.encoding });
      return;
    }

    const token = this.#token;
    this.#setBody(seq, { kind: 'loading' });
    let res: Awaited<ReturnType<Api['fetchFrameBody']>>;
    try {
      res = await this.#api.fetchFrameBody(sel.deviceId, sel.wsId, seq);
    } catch {
      res = { kind: 'error' };
    }
    if (token !== this.#token) return; // a session switch superseded this load
    if (res.kind === 'ok') {
      this.#cache.putRaw(hash, res.text);
      // Real byte size when the ref carried none: decoded bytes for a base64
      // (binary) frame, UTF-8 bytes for text — never the UTF-16 string length.
      const bytes = ref.encoding === 'binary' ? base64ByteLength(res.text) : utf8Bytes(res.text);
      this.#setBody(seq, { kind: 'ok', hash, size: ref.size ?? bytes, encoding: ref.encoding });
    } else if (res.kind === 'omitted') {
      this.#setBody(seq, { kind: 'omitted', reason: res.reason as BodyOmission, size: ref.size ?? 0 });
    } else if (res.kind === 'error') {
      // A transport/5xx failure: recoverable, so the frame offers a Retry.
      this.#setBody(seq, { kind: 'error' });
    } else {
      this.#setBody(seq, { kind: 'gone' });
    }
  }

  #onBatch(batch: UiMessage[]): void {
    const id = this.selectedId;
    if (!id) return;
    const sel = this.#store.ws.find((s) => s.wsId === id);
    // The selected session left the store (a clear or retention eviction): drop the
    // selection and its frames so the detail pane empties.
    if (!sel) {
      this.selectedId = null;
      this.frames = [];
      this.expanded.clear();
      this.bodies = {};
      this.framesStatus = 'idle';
      return;
    }
    const hasFrame = batch.some((m) => m.type === 'ws_frame' && m.wsId === id && m.deviceId === sel.deviceId);
    if (!hasFrame) return;
    // The prior load failed and left the tail parked. A fresh live frame proves the
    // session is producing again, so retry the load rather than waiting for a manual
    // Retry — but cap it: at most MAX_AUTO_RETRIES consecutive automatic attempts,
    // each at least RETRY_MIN_INTERVAL_MS apart, then stay in error until the user
    // hits Retry. A success (in `select`) resets the counter.
    if (this.framesStatus === 'error') {
      if (this.#autoRetries >= MAX_AUTO_RETRIES) return;
      const now = Date.now();
      if (now - this.#lastAutoRetryAt < RETRY_MIN_INTERVAL_MS) return;
      this.#autoRetries += 1;
      this.#lastAutoRetryAt = now;
      void this.select(id);
      return;
    }
    // A frame arrived while the initial page was still loading: defer the tail to
    // when `select` settles, rather than racing it with an empty frame list.
    if (this.framesStatus !== 'done') { this.#tailPending = true; return; }
    // Live tail: the initial load has settled, no older page is anchored, and no
    // tail is already in flight → fetch just past the last shown sequence.
    if (this.#loadedOlder || this.#tailing) return;
    void this.#tail(sel);
  }

  async #tail(sel: WsSummary): Promise<void> {
    this.#tailing = true;
    const token = this.#token;
    const last = this.frames.length ? this.frames[this.frames.length - 1].sequence : null;
    try {
      const page = await this.#api.fetchFrames(sel.deviceId, sel.wsId, last, PAGE);
      if (token !== this.#token) return;
      const fresh = page.items.filter((f) => last == null || f.sequence > last);
      if (fresh.length === 0) return;
      let merged = this.#dedupeAsc([...this.frames, ...fresh]);
      // Anchored to the live edge: keep only the newest window so a long-lived
      // session does not grow the array without bound (matches server retention).
      if (merged.length > MAX_FRAMES) merged = merged.slice(merged.length - MAX_FRAMES);
      this.frames = merged;
      // The trim may have dropped the oldest frames off the top, so older history
      // is now pageable again — recompute rather than leaving a stale `atOldest`.
      this.atOldest = merged[0]?.sequence === 0;
      // Keep `hasNewer` honest with the tail's cursor. While auto-tailing this does
      // not surface "Load newer" (see `canLoadNewer`); it matters if the viewport is
      // later anchored, so the forward affordance reflects the real edge.
      this.hasNewer = page.nextCursor != null;
    } finally {
      this.#tailing = false;
    }
  }

  // Replace one frame's body; a fresh object so the $state assignment fires.
  #setBody(seq: number, s: BodyState): void {
    this.bodies = { ...this.bodies, [seq]: s };
  }

  #asc(items: FrameSummary[]): FrameSummary[] {
    return [...items].sort((a, b) => a.sequence - b.sequence);
  }

  #dedupeAsc(items: FrameSummary[]): FrameSummary[] {
    const map = new Map<number, FrameSummary>();
    for (const f of items) map.set(f.sequence, f);
    return [...map.values()].sort((a, b) => a.sequence - b.sequence);
  }
}
