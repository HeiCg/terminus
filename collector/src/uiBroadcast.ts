import type { Store } from './store.js';
import type { Device, EntryKey, WsKey, BodyRef, Source } from './types.js';
import type { UiMessage, EntrySummary, WsSummary, FrameSummary, UiDevice, SnapshotMessage, Page } from './uiProtocol.js';
import { MAX_UI_MESSAGE_BYTES, PROTOCOL_VERSION } from './uiProtocol.js';
import { log } from './log.js';

// A neutral, empty BodyRef for the last-resort marker carrier (no bytes, bounded).
const EMPTY_REF: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };

// The slice of the ws.WebSocket surface the broadcaster relies on; the real
// socket satisfies it, and tests can fake it deterministically. We do not read
// `bufferedAmount`: byte accounting is done from the send callback (bytes handed
// to send() whose write has not completed), which already subsumes it, so the
// two are never mixed or double counted.
export interface UiSocket {
  readyState: number;
  readonly OPEN: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: 'close', cb: () => void): unknown;
}

export interface UiBroadcastOptions {
  // Overridable so a test can prove the payload is serialized once per fanout.
  serialize?: (m: UiMessage) => string;
  perSocketBytes?: number;
  globalBytes?: number;
  maxSockets?: number;
  maxPerSession?: number;
  maxMessageBytes?: number;
}

// O06 output caps.
const DEFAULTS = {
  perSocketBytes: 8 * 1024 * 1024,
  globalBytes: 32 * 1024 * 1024,
  maxSockets: 16,
  maxPerSession: 4,
  maxMessageBytes: MAX_UI_MESSAGE_BYTES,
};

// Bounded length for a single string in the clipping carrier; small enough that
// a record of clipped strings is orders of magnitude under the cap.
const CLIP_BYTES = 1024;
const clip = (s: string): string => (s.length > CLIP_BYTES ? s.slice(0, CLIP_BYTES) : s);
// Depth ceiling for the structural clip; today's records are two levels deep
// (message → record → headers), so this only ever bites on a malformed value.
const MAX_CLIP_DEPTH = 6;

// Clip every string anywhere in a value, whatever the field is called (keys
// included). Enumerating the "unbounded" fields has repeatedly missed one —
// nothing at ingest length-caps any device-supplied string, so ids, device
// fields and bodyOmitted are as unbounded as url or error. Clipping
// structurally means a field added later is covered without a code change.
function clipStrings<T>(v: T, st: { clipped: boolean } = { clipped: false }, depth = 0): T {
  if (typeof v === 'string') { if (v.length > CLIP_BYTES) st.clipped = true; return clip(v) as unknown as T; }
  if (v === null || typeof v !== 'object') return v;
  if (depth >= MAX_CLIP_DEPTH) { st.clipped = true; return (Array.isArray(v) ? [] : {}) as unknown as T; }
  if (Array.isArray(v)) return v.map((x) => clipStrings(x, st, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k.length > CLIP_BYTES) st.clipped = true;
    out[clip(k)] = clipStrings(val, st, depth + 1);
  }
  return out as unknown as T;
}

// The final marker carrier clips harder still and keeps nothing but identity.
const MARKER_CLIP_BYTES = 256;
const mclip = (s: string): string => (typeof s === 'string' ? s.slice(0, MARKER_CLIP_BYTES) : '');
// A number always serializes to a couple of dozen characters; normalising the
// non-finite ones keeps the marker's size independent of its input.
const mnum = (n: number): number => (Number.isFinite(n) ? n : 0);
// `source` is a small fixed enum, not device-supplied text, so the marker keeps it
// intact (never collapsing `proxy` into `xhr`) while staying bounded by construction.
const clipSource = (s: Source): Source => (s === 'atlantis' || s === 'proxy' || s === 'replay' ? s : 'xhr');
// Ceiling on a SCALAR marker message (entry / ws / ws_frame / device / clear /
// atmax): each is built from literals plus at most two MARKER_CLIP_BYTES-long ids
// (which JSON can escape to 6 bytes per character), so its worst case is a few KiB.
// 64 KiB leaves an order of magnitude of headroom, and `maxMessageBytes` is clamped
// to at least this, so the final guard cannot ship a scalar marker over the cap.
// The two REMOVAL markers are the exception: they carry a key LIST, so their worst
// case is not a few KiB — up to REMOVAL_MAX_KEYS clipped keys (~hundreds of KiB
// escaped). What keeps them safe is not this ceiling but the byte-chunking below:
// removal messages are split to <= REMOVAL_MAX_BYTES before fanout, so a removal
// never reaches the marker under the default 2 MiB cap, and even the marker's
// worst case stays under that cap. See chunkKeys.
const MARKER_MAX_BYTES = 64 * 1024;
// Upper bound on keys carried in a last-resort removal carrier; removal batches
// are chunked below this before fanout, so the marker never truncates.
const MARKER_MAX_KEYS = 1000;
// Removal messages are chunked by measured BYTES (a device-supplied id can be long,
// so a fixed key count is not enough to respect the marker bound). Each chunk stays
// under this budget, well below MARKER_MAX_BYTES (64 KiB) and the 2 MiB message cap;
// a secondary key-count cap keeps a chunk from carrying more than the marker holds.
const REMOVAL_MAX_BYTES = 48 * 1024;
const REMOVAL_MAX_KEYS = 500;

// Split keys into chunks whose serialized size stays under REMOVAL_MAX_BYTES (and
// REMOVAL_MAX_KEYS), then fan out one message per chunk (order preserved). Sizing is
// by MEASURED serialized bytes, not string length: a device-supplied id with control
// or non-BMP characters escapes to many more bytes than chars (\u00XX, surrogate
// pairs), so a char-count budget would under-count and blow the bound. A single key
// larger than the budget still ships alone — the marker then clips its strings,
// never drops the key.
function chunkKeys<K>(keys: K[]): K[][] {
  const chunks: K[][] = [];
  let cur: K[] = []; let used = 2; // "[]"
  for (const k of keys) {
    const s = Buffer.byteLength(JSON.stringify(k)) + 1; // exact wire cost of this key
    if (cur.length > 0 && (used + s > REMOVAL_MAX_BYTES || cur.length >= REMOVAL_MAX_KEYS)) { chunks.push(cur); cur = []; used = 2; }
    cur.push(k); used += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

interface Client { socket: UiSocket; sid: string | null; queued: number; released: boolean; }

export type UiBroadcast = ReturnType<typeof createUiBroadcast>;

// One broadcaster per server: a single set of Store listeners feeds every UI
// socket, each delta is serialized once, and per-socket/global byte budgets
// close a client that stops reading (it resyncs from a fresh snapshot on
// reconnect) rather than letting a queue grow without bound.
export function createUiBroadcast(store: Store, opts: UiBroadcastOptions = {}) {
  const serialize = opts.serialize ?? ((m: UiMessage) => JSON.stringify(m));
  const perSocketBytes = opts.perSocketBytes ?? DEFAULTS.perSocketBytes;
  const globalBytes = opts.globalBytes ?? DEFAULTS.globalBytes;
  const maxSockets = opts.maxSockets ?? DEFAULTS.maxSockets;
  const maxPerSession = opts.maxPerSession ?? DEFAULTS.maxPerSession;
  // Clamped so the marker carrier always fits: a cap below MARKER_MAX_BYTES
  // would leave nothing sendable at all.
  const maxMessageBytes = Math.max(opts.maxMessageBytes ?? DEFAULTS.maxMessageBytes, MARKER_MAX_BYTES);

  const clients = new Set<Client>();
  let globalQueued = 0;
  let overload = 0;
  let markered = 0;
  // While paused, fanout() drops every store delta (the store keeps recording);
  // resume replays a fresh snapshot so the client catches up on what it missed.
  let paused = false;

  // A snapshot that always fits under the message cap: bodies/frame payloads are
  // dropped (refetchable via /api/*) and the store is taken newest-first,
  // truncating the tail when even the metadata would exceed the budget. The
  // snapshot is the resync path, so it must never be refused — the old behaviour
  // of closing the socket locked the UI out whenever the store grew.
  function buildSnapshot(): SnapshotMessage {
    const atMax = store.atMax();
    const devices: UiDevice[] = [];
    const entryItems: EntrySummary[] = [];
    const wsItems: WsSummary[] = [];
    let truncated = false;
    // RetentionCounters carries exactly the RetentionMessage fields (minus `type`).
    const retention = store.retentionCounters();
    // Size of the envelope with empty pages; each item's own serialized length
    // plus a comma is added below (a slight over-estimate, so the real payload
    // stays at or under the cap).
    let used = Buffer.byteLength(JSON.stringify({ type: 'snapshot', devices: [], entries: { items: [], nextCursor: null }, ws: { items: [], nextCursor: null }, retention, atMax, truncated: false, paused, protocolVersion: PROTOCOL_VERSION }));

    // Devices are as device-supplied and unbounded as summaries, so they are
    // clipped and sized like everything else instead of being baked in whole.
    const byNewestDevice = store.devices().sort((a, b) => b.lastSeen - a.lastSeen);
    for (const d of byNewestDevice) {
      const st = { clipped: false };
      const clipped = clipStrings(d, st);
      const ld: UiDevice = st.clipped ? { ...clipped, identityClipped: true } : clipped;
      const size = Buffer.byteLength(JSON.stringify(ld)) + 1;
      if (used + size > maxMessageBytes) { truncated = true; break; }
      used += size; devices.push(ld);
    }
    // Newest-first SUMMARIES straight from the store's ordered index — no bodies,
    // no frame arrays, no BodyStore reads, so a snapshot never materializes
    // retained text (O07) and each item is bounded by maxRecordBytes (64 KiB).
    for (const es of store.snapshotEntrySummaries()) {
      const size = Buffer.byteLength(JSON.stringify(es)) + 1;
      if (used + size > maxMessageBytes) { truncated = true; break; }
      used += size; entryItems.push(es);
    }
    for (const wss of store.snapshotWsSummaries()) {
      const size = Buffer.byteLength(JSON.stringify(wss)) + 1;
      if (used + size > maxMessageBytes) { truncated = true; break; }
      used += size; wsItems.push(wss);
    }
    // Restore chronological order for the UI's own ascending sort. The snapshot is
    // the newest window; older records page from the /api/* routes (nextCursor
    // null here — deep scroll-back paging is a separate UI concern).
    entryItems.reverse(); wsItems.reverse();
    const entries: Page<EntrySummary> = { items: entryItems, nextCursor: null };
    const ws: Page<WsSummary> = { items: wsItems, nextCursor: null };
    return { type: 'snapshot', devices, entries, ws, retention, atMax, truncated, paused, protocolVersion: PROTOCOL_VERSION };
  }

  // Stage 1: summaries carry no bodies, headers or frame arrays, so the only way a
  // single delta exceeds the cap is one huge device-supplied string (id, url,
  // wsId, error, closeReason, a device field). Clip every string structurally —
  // whatever the field is called — and mark the record; the byte budgets, chunked
  // removals and the 2 MiB structural guarantee are otherwise unchanged from T02.
  function identify(m: UiMessage): UiMessage {
    const c = clipStrings(m);
    if (c.type === 'entry') return { type: 'entry', entry: { ...c.entry, identityClipped: true } };
    if (c.type === 'ws') return { type: 'ws', session: { ...c.session, identityClipped: true } };
    if (c.type === 'device') return { type: 'device', device: { ...c.device, identityClipped: true } };
    return c;
  }

  // Final guard. Whatever the input shape, what goes on the wire is this carrier,
  // built from literals plus at most two clipped ids, so its size is bounded by
  // construction (MARKER_MAX_BYTES) rather than by any property of the input. The
  // switch is exhaustive, so a new message type or record field is a compile error
  // here instead of another unbounded field on the wire.
  function marker(m: UiMessage): UiMessage {
    switch (m.type) {
      case 'entry': {
        const e = m.entry;
        return { type: 'entry', entry: {
          id: mclip(e.id), deviceId: mclip(e.deviceId), source: clipSource(e.source),
          startedAt: mnum(e.startedAt), method: '', url: '',
          status: e.status === null ? null : mnum(e.status),
          durationMs: e.durationMs === null ? null : mnum(e.durationMs), error: null,
          requestBody: EMPTY_REF, responseBody: EMPTY_REF, identityClipped: true } };
      }
      case 'ws': {
        const s = m.session;
        return { type: 'ws', session: {
          wsId: mclip(s.wsId), deviceId: mclip(s.deviceId), source: clipSource(s.source),
          url: '', openedAt: mnum(s.openedAt),
          kind: s.kind === 'sse' ? 'sse' : 'websocket', httpEntryKey: null,
          closedAt: s.closedAt === null ? null : mnum(s.closedAt),
          closeCode: s.closeCode === null ? null : mnum(s.closeCode), closeReason: '',
          retainedFrames: mnum(s.retainedFrames), totalFrames: mnum(s.totalFrames), droppedFrames: mnum(s.droppedFrames),
          partial: s.partial === true, resumed: s.resumed === true, identityClipped: true } };
      }
      case 'ws_frame':
        return { type: 'ws_frame', wsId: mclip(m.wsId), deviceId: mclip(m.deviceId),
          retainedFrames: mnum(m.retainedFrames), totalFrames: mnum(m.totalFrames), droppedFrames: mnum(m.droppedFrames),
          frame: {
            sequence: mnum(m.frame.sequence), ts: mnum(m.frame.ts), direction: m.frame.direction === 'out' ? 'out' : 'in',
            binary: m.frame.binary === true, body: EMPTY_REF } };
      case 'device':
        return { type: 'device', device: {
          deviceId: mclip(m.device.deviceId), platform: '', appVersion: '', buildProfile: '',
          dropped: mnum(m.device.dropped), lastSeen: mnum(m.device.lastSeen), identityClipped: true } };
      case 'clear':
        return { type: 'clear', deviceId: m.deviceId === null ? null : mclip(m.deviceId) };
      case 'atmax':
        return { type: 'atmax', atMax: m.atMax === true };
      case 'snapshot':
        return { type: 'snapshot', devices: [], entries: { items: [], nextCursor: null }, ws: { items: [], nextCursor: null }, retention: null, atMax: m.atMax === true, truncated: true, paused: m.paused === true };
      case 'paused':
        return { type: 'paused', paused: m.paused === true };
      case 'entries_removed':
        // Bound the key list by construction; a removal larger than this batch
        // resolves on the next reconnect snapshot.
        return { type: 'entries_removed', keys: m.keys.slice(0, MARKER_MAX_KEYS).map((k) => ({ deviceId: mclip(k.deviceId), id: mclip(k.id) })) };
      case 'sessions_removed':
        return { type: 'sessions_removed', keys: m.keys.slice(0, MARKER_MAX_KEYS).map((k) => ({ deviceId: mclip(k.deviceId), wsId: mclip(k.wsId) })) };
      case 'retention':
        return { type: 'retention', retainedBodyBytes: mnum(m.retainedBodyBytes), retainedMetadataBytes: mnum(m.retainedMetadataBytes),
          droppedEntries: mnum(m.droppedEntries), droppedSessions: mnum(m.droppedSessions), droppedFrames: mnum(m.droppedFrames), omittedBodies: mnum(m.omittedBodies), refusedSessions: mnum(m.refusedSessions), rejectedRecords: mnum(m.rejectedRecords), evictedForBodyBudget: mnum(m.evictedForBodyBudget) };
    }
  }

  // Serialize and, only if over the cap, clip every string then fall back to the
  // last-resort marker carrier — re-measuring exact wire bytes after each so
  // nothing is dropped and nothing ships over the cap. Summaries make the earlier
  // body/header/frame-strip stages unnecessary; the marker is still the guarantee,
  // counted, never silently swallowed.
  function fit(m: UiMessage): string {
    const over = (s: string) => Buffer.byteLength(s) > maxMessageBytes;
    let data = serialize(m);
    if (over(data)) data = serialize(identify(m));
    if (over(data)) { markered++; data = serialize(marker(m)); }
    return data;
  }

  const onEntry = (entry: EntrySummary) => fanout({ type: 'entry', entry });
  const onWs = (session: WsSummary) => fanout({ type: 'ws', session });
  const onWsFrame = (e: { wsId: string; deviceId: string; frame: FrameSummary; retainedFrames: number; totalFrames: number; droppedFrames: number }) =>
    fanout({ type: 'ws_frame', wsId: e.wsId, deviceId: e.deviceId, frame: e.frame, retainedFrames: e.retainedFrames, totalFrames: e.totalFrames, droppedFrames: e.droppedFrames });
  const onDevice = (device: Device) => fanout({ type: 'device', device });
  const onClear = (deviceId: string | null) => fanout({ type: 'clear', deviceId });
  const onAtMax = (atMax: boolean) => fanout({ type: 'atmax', atMax });
  // Removal batches are chunked by BYTES so each message stays well under the marker
  // bound even when device-supplied ids are long; multiple messages are fine because
  // they are ordered. `fit()` therefore never has to drop keys to satisfy the cap —
  // the last-resort marker only clips id STRINGS, never removes a key.
  const onEntriesRemoved = (e: { keys: EntryKey[] }) => {
    for (const chunk of chunkKeys(e.keys)) fanout({ type: 'entries_removed', keys: chunk });
  };
  const onSessionsRemoved = (e: { keys: WsKey[] }) => {
    for (const chunk of chunkKeys(e.keys)) fanout({ type: 'sessions_removed', keys: chunk });
  };
  const onRetention = (m: Extract<UiMessage, { type: 'retention' }>) => fanout(m);

  // Attach the shared listeners only while a socket is connected, so an idle
  // server holds none and closing the last socket returns the store to baseline.
  let attached = false;
  const attach = () => {
    if (attached) return; attached = true;
    store.on('entry', onEntry); store.on('ws', onWs); store.on('wsframe', onWsFrame);
    store.on('device', onDevice); store.on('clear', onClear); store.on('atmax', onAtMax);
    store.on('entries_removed', onEntriesRemoved); store.on('sessions_removed', onSessionsRemoved);
    store.on('retention', onRetention);
  };
  const detach = () => {
    if (!attached) return; attached = false;
    store.off('entry', onEntry); store.off('ws', onWs); store.off('wsframe', onWsFrame);
    store.off('device', onDevice); store.off('clear', onClear); store.off('atmax', onAtMax);
    store.off('entries_removed', onEntriesRemoved); store.off('sessions_removed', onSessionsRemoved);
    store.off('retention', onRetention);
  };

  // Drop a client and give back its outstanding bytes exactly once. The
  // `released` flag also neuters any still-pending send callback, which ws fires
  // (with an error) after close — without it, those callbacks would keep
  // subtracting and drive globalQueued negative, silently loosening the cap.
  function release(c: Client): void {
    if (c.released) return;
    c.released = true;
    clients.delete(c);
    globalQueued -= c.queued; c.queued = 0;
    if (clients.size === 0) detach();
  }

  // Send an already-serialized payload to one client with byte accounting. A
  // client that would breach its own or the global budget is closed and drops
  // from the fanout; nothing is silently skipped for a client that keeps up.
  function push(c: Client, data: string, len: number): void {
    if (c.released || c.socket.readyState !== c.socket.OPEN) return;
    if (c.queued + len > perSocketBytes || globalQueued + len > globalBytes) {
      overload++; safeClose(c.socket); release(c); return;
    }
    c.queued += len; globalQueued += len;
    // A torn-down or hostile socket can throw synchronously from send(). Treat it
    // like an overloaded client: log, close, and drop it from the fanout so one
    // bad socket never aborts delivery to the rest (or crashes a control message
    // like pause/resume, which would otherwise leave /api/pause without a reply).
    try {
      c.socket.send(data, () => { if (c.released) return; c.queued -= len; globalQueued -= len; });
    } catch (e) {
      log.warn('ui socket send failed', String(e));
      c.queued -= len; globalQueued -= len;
      safeClose(c.socket); release(c);
    }
  }

  // Closing a socket can itself throw (a torn-down or hostile socket); never let
  // that propagate — one throwing close must not abort a fanout/teardown loop or
  // leave a client registered. Every raw socket.close() goes through here.
  function safeClose(socket: UiSocket): void {
    try { socket.close(); } catch (e) { log.warn('ui socket close failed', String(e)); }
  }

  // Serialize once and deliver the fitted payload to every live client. This is
  // the byte-accounted delivery primitive; fanout() gates it on `paused`, while
  // the pause/resume control messages go through it directly (bypassing the gate).
  function emit(m: UiMessage): void {
    const data = fit(m);
    const len = Buffer.byteLength(data);
    for (const c of [...clients]) push(c, data, len);
  }

  function fanout(m: UiMessage): void {
    // While paused the store keeps recording, but no delta reaches a client; the
    // next resume replays a fresh snapshot so nothing is silently lost.
    if (paused) return;
    emit(m);
  }

  // Push a fresh, fitted snapshot to every live client — the resync path after a
  // resume. buildSnapshot() reads the store once; the same payload fits and ships
  // to all, held to the cap by the same final guard as `add`.
  function resyncAll(): void {
    emit(buildSnapshot());
  }

  return {
    // Register a socket, enforce the socket-count caps, then send its (always
    // fitting) snapshot. Returns false (and closes the socket) when a cap
    // rejects it.
    add(socket: UiSocket, sid: string | null): boolean {
      if (clients.size >= maxSockets) { safeClose(socket); return false; }
      if (sid) {
        let n = 0; for (const c of clients) if (c.sid === sid) n++;
        if (n >= maxPerSession) { safeClose(socket); return false; }
      }
      const c: Client = { socket, sid, queued: 0, released: false };
      clients.add(c); attach();
      socket.on('close', () => release(c));
      // Through the same guard as a delta: buildSnapshot() sizes every item, but
      // the snapshot is held to the cap on the wire by the same final check.
      const snap = fit(buildSnapshot());
      push(c, snap, Buffer.byteLength(snap));
      return true;
    },
    closeSession(sid: string): void {
      for (const c of [...clients]) if (c.sid === sid) { safeClose(c.socket); release(c); }
    },
    // Toggle the live stream. Idempotent: a no-op when already in the requested
    // state. Pausing announces `{paused:true}` to every client (via emit, not
    // fanout, so it is not itself dropped by the pause gate) and then drops deltas;
    // resuming announces `{paused:false}` and replays a fresh snapshot so the
    // client catches up on everything the store recorded while paused.
    setPaused(next: boolean): void {
      if (paused === next) return;
      paused = next;
      emit({ type: 'paused', paused });
      if (!paused) resyncAll();
    },
    isPaused(): boolean { return paused; },
    resyncAll,
    size(): number { return clients.size; },
    queuedBytes(): number { return globalQueued; },
    overloaded(): number { return overload; },
    // Messages that reached the last-resort marker carrier: nothing was dropped,
    // but the record was reduced to identity. Non-zero means a shrink stage let
    // an over-cap shape through and should be extended.
    markered(): number { return markered; },
    close(): void { for (const c of [...clients]) { safeClose(c.socket); release(c); } },
  };
}
