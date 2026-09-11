import { EventEmitter } from 'node:events';
import type {
  DeviceMessage, Entry, EntryInput, StoredEntry, StoredFrame, WsSession, WsSessionInput,
  Device, DeviceChannels, BodyRef, BodyOmitted, EntryKey, WsKey, ExportSelection, ExportSession, ExportSnapshot,
} from './types.js';
import { createBodyStore, type BodyStore } from './bodyStore.js';
import { createSessionAdmission, type SessionAdmission, type AdmissionOutcome } from './sessionAdmission.js';
import { SortedKeyIndex, serializedBytes, type RetentionLimits, type SortKey } from './retention.js';
import {
  makeBodyRef, releaseBodyRef, storedToEntry, legacyEntryToInput,
  storedToEntrySummary, storedToEntryDetail, storedFrameToSummary, readBodyBytes, type BodyBytes,
} from './captureDto.js';
import type { UiDevice, EntrySummary, EntryDetail, WsSummary, FrameSummary, Page } from './uiProtocol.js';
import { redactUrl, redactHeaders, redactText } from './redactor.js';

// Metadata-page ceilings shared by the summary endpoints (SPEC): a page carries
// at most 200 records and 1 MiB serialized, whichever is hit first.
const PAGE_MAX_RECORDS = 200;
const PAGE_MAX_BYTES = 1024 * 1024;

// Encode/decode the opaque page cursor: the base64url of a [ts, deviceId, id]
// SortKey. A malformed cursor decodes to null (page from the start) rather than
// throwing, so a stale client can never wedge a listing.
function encodeCursor(sk: SortKey | null): string | null {
  return sk ? Buffer.from(JSON.stringify(sk)).toString('base64url') : null;
}
function decodeCursor(raw: string | null | undefined): SortKey | null {
  if (!raw) return null;
  try { const p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); return Array.isArray(p) && p.length === 3 ? (p as unknown as SortKey) : null; }
  catch { return null; }
}

// Per-device HTTP entry cap (kept as a named export for the existing store tests).
export const MAX_ENTRIES = 5000;

// Export lease ceiling (global constraint): a snapshot self-releases its held
// body references after at most 30 s so an abandoned export never pins bytes.
export const EXPORT_LEASE_MS = 30_000;

// The Store's default retention limits are the SPEC values, enforced on EVERY
// write path (both the Atlantis byte path and the legacy `addEntry`/`appendWsFrame`
// text path): a body over 1 MiB or a WS message over 256 KiB is omitted with a
// reason at the store boundary, not just at decode. `maxRecordBytes` bounds a
// single record's metadata; it defaults to the whole metadata budget so a large
// device-supplied identity string is still admitted and clipped by the UI fanout
// (the T02 transitional DTO), while every cap remains a constructor option so tests
// (and, transitionally, the O06 fanout tests) can relax or tighten each boundary.
export const STORE_DEFAULT_LIMITS: RetentionLimits = {
  bodyBytes: 64 * 1024 * 1024,
  perBodyBytes: 1 * 1024 * 1024,
  perWsMessageBytes: 256 * 1024,
  metadataBytes: 32 * 1024 * 1024,
  // A single HTTP record whose metadata (headers, url, identity — bodies live in
  // the BodyStore's own budget) exceeds 64 KiB is rejected whole (SPEC). The UI
  // fanout still clips oversized device-supplied strings defensively, but the
  // store no longer retains a multi-megabyte identity record; the O06 fanout
  // tests relax this via the constructor to exercise that clip path.
  maxRecordBytes: 64 * 1024,
  httpPerDevice: MAX_ENTRIES,
  httpGlobal: 20000,
  wsSessionsPerDevice: 100,
  wsSessionsGlobal: 500,
  wsMessagesPerSession: 2000,
  wsMessagesGlobal: 20000,
  admissionIdsPerGeneration: 4096,
  admissionBytes: 1 * 1024 * 1024,
};

const keyOf = (deviceId: string, id: string): string => JSON.stringify([deviceId, id]);

// Cumulative retention counters, emitted as a `retention` event whenever the
// store drops something. RSS is deliberately not here: retained bytes are what
// the store holds, not what the process's heap has released back to the OS.
export type RetentionCounters = {
  retainedBodyBytes: number; retainedMetadataBytes: number;
  droppedEntries: number; droppedSessions: number; droppedFrames: number;
  omittedBodies: number; rejectedRecords: number;
  // Sessions the admission authority refused outright (a late frame after removal,
  // or the registry full) — distinct from `droppedSessions` (retained-then-evicted).
  refusedSessions: number;
};

type StoredSession = {
  session: Omit<WsSession, 'frames'>;
  frames: StoredFrame[];
  metaBytes: number; // serialized metadata size (session shell + frame metadata)
  generation: string;
  // Frame accounting for the WsSummary the UI pages: `nextSeq` is the monotonic
  // sequence assigned to the next appended frame (also the count of frames ever
  // admitted); `droppedLocal` counts this session's frames evicted for retention.
  nextSeq: number;
  droppedLocal: number;
};

export type StoreOptions = { limits?: Partial<RetentionLimits>; bodies?: BodyStore };

// In-memory capture store with bounded retention on every axis (R6/O03/O04/O05).
// Bodies are held once in the content-addressed BodyStore; records hold only
// references. The external API still speaks the legacy text `Entry`/`WsSession`
// DTO (materialized on read) so the T02 UI, HTTP and HAR layers are unchanged.
export class Store extends EventEmitter {
  private readonly limits: RetentionLimits;
  private readonly bodies: BodyStore;
  private readonly admission: SessionAdmission;

  // Insertion-ordered maps double as the admission-order deques for eviction:
  // the first key a Map yields is the oldest admitted.
  private entriesByKey = new Map<string, StoredEntry>();
  private entryMeta = new Map<string, number>();          // key -> serialized metadata bytes
  private entryDevice = new Map<string, Set<string>>();   // deviceId -> keys (insertion order)
  private entryIndexGlobal = new SortedKeyIndex();
  private entryIndexByDevice = new Map<string, SortedKeyIndex>();

  private sessionsByKey = new Map<string, StoredSession>();
  private wsIdToKey = new Map<string, string>(); // wsId -> composite key (last writer wins, as before)
  private sessionDevice = new Map<string, Set<string>>();
  private sessionIndexGlobal = new SortedKeyIndex();
  private sessionIndexByDevice = new Map<string, SortedKeyIndex>();
  private totalFrames = 0;

  private devs = new Map<string, Device>();
  private deviceMeta = new Map<string, number>();

  // Device-identity aliases (in memory only): a key an Atlantis channel presents
  // under -> the primary deviceId the app's ingest hello declared. Traffic, ws
  // sessions and channel touches arriving under an alias key are attributed to the
  // primary so one phone that shows up on two channels is a single device.
  private aliases = new Map<string, string>();

  private metadataBytes = 0;
  private capped = false;
  private retentionDirty = false; // a drop/omission happened this op -> emit retention
  private counters: RetentionCounters = {
    retainedBodyBytes: 0, retainedMetadataBytes: 0,
    droppedEntries: 0, droppedSessions: 0, droppedFrames: 0, omittedBodies: 0, rejectedRecords: 0, refusedSessions: 0,
  };

  constructor(opts: StoreOptions = {}) {
    super();
    this.limits = { ...STORE_DEFAULT_LIMITS, ...(opts.limits ?? {}) };
    this.bodies = opts.bodies ?? createBodyStore({ maxBytes: this.limits.bodyBytes });
    this.admission = createSessionAdmission(this.limits);
  }

  // ---- HTTP entries -------------------------------------------------------

  // Legacy entry point: an `Entry` with text bodies (fixtures, WSS ingest that
  // already decoded JSON text). Converted to byte input, then upserted.
  addEntry(e: Entry): void { this.addEntryInput(legacyEntryToInput(e)); }

  // Byte entry point (Atlantis decode): bytes are preserved and hashed.
  addEntryInput(input: EntryInput): void {
    const key = keyOf(input.deviceId, input.id);
    const existing = this.entriesByKey.get(key);

    const reqRef = makeBodyRef(input.requestBytes, input.requestBodyOmitted, input.requestBodySize, this.bodies, this.limits.perBodyBytes);
    const resRef = makeBodyRef(input.responseBytes, input.responseBodyOmitted, input.responseBodySize, this.bodies, this.limits.perBodyBytes);
    this.countOmission(reqRef); this.countOmission(resRef);

    const { requestBytes: _rb, responseBytes: _sb, requestBodySize: _rs, responseBodySize: _ss, requestBodyOmitted: _ro, responseBodyOmitted: _so, ...meta } = input;
    const stored: StoredEntry = { ...meta, requestBody: reqRef, responseBody: resRef };
    const recBytes = serializedBytes(stored);

    if (recBytes > this.limits.maxRecordBytes) {
      // Individual record too large: reject it, release any bytes it acquired.
      releaseBodyRef(reqRef, this.bodies); releaseBodyRef(resRef, this.bodies);
      this.counters.rejectedRecords++;
      this.retentionDirty = true;
      this.flushRetention();
      return;
    }

    if (existing) {
      // Upsert: release the old bodies (acquire/release nets to zero when a body
      // is unchanged, so an identical re-send does not raise the blob refcount),
      // and re-index if the ordering key (startedAt) changed.
      releaseBodyRef(existing.requestBody, this.bodies);
      releaseBodyRef(existing.responseBody, this.bodies);
      this.metadataBytes -= this.entryMeta.get(key) ?? 0;
      if (existing.startedAt !== stored.startedAt) {
        this.entryIndexGlobal.remove(this.entrySk(existing));
        this.entryIndexByDevice.get(existing.deviceId)?.remove(this.entrySk(existing));
        this.entryIndexGlobal.insert(this.entrySk(stored), { deviceId: stored.deviceId, id: stored.id });
        this.deviceEntryIndex(stored.deviceId).insert(this.entrySk(stored), { deviceId: stored.deviceId, id: stored.id });
      }
      this.entriesByKey.set(key, stored);
      this.entryMeta.set(key, recBytes);
      this.metadataBytes += recBytes;
    } else {
      this.entriesByKey.set(key, stored);
      this.entryMeta.set(key, recBytes);
      this.metadataBytes += recBytes;
      this.deviceEntries(stored.deviceId).add(key);
      const sk = this.entrySk(stored);
      this.entryIndexGlobal.insert(sk, { deviceId: stored.deviceId, id: stored.id });
      this.deviceEntryIndex(stored.deviceId).insert(sk, { deviceId: stored.deviceId, id: stored.id });
      this.evictEntries(stored.deviceId);
    }
    this.evictMetadata();
    // Incremental delta carries a SUMMARY (BodyRef, no body text): a live entry
    // never materializes retained bytes out of the BodyStore onto the wire.
    this.emit('entry', storedToEntrySummary(this.entriesByKey.get(key)!));
    this.flushRetention();
  }

  updateEntry(id: string, patch: Partial<Entry>): void {
    // Legacy id-only signature (kept for compatibility). Prefer patchEntry with a
    // deviceId on the hot ingest path; this scans as a fallback.
    for (const stored of this.entriesByKey.values()) {
      if (stored.id === id) return void this.addEntry({ ...this.toEntry(stored), ...patch });
    }
  }

  // Device-scoped response correlation (WSS/XHR request->response). Byte-native:
  // it swaps in a fresh response BodyRef and carries the existing REQUEST ref over
  // untouched, so a captured (binary) request body survives the response merge —
  // the retired text-DTO round-trip re-encoded the request and lost its bytes.
  private patchEntryResponse(deviceId: string, id: string, r: {
    status: number | null; statusText: string; responseHeaders: Record<string, string>;
    responseBody: string | null; responseBodySize: number; responseBodyOmitted: BodyOmitted;
    durationMs: number | null; error: string | null;
  }): void {
    const key = keyOf(deviceId, id);
    const existing = this.entriesByKey.get(key);
    if (!existing) return;
    const bytes = r.responseBody != null && r.responseBodyOmitted == null ? Buffer.from(r.responseBody, 'utf8') : null;
    const resRef = makeBodyRef(bytes, r.responseBodyOmitted, r.responseBodySize, this.bodies, this.limits.perBodyBytes);
    this.countOmission(resRef);
    const merged: StoredEntry = {
      ...existing, status: r.status, statusText: r.statusText, responseHeaders: r.responseHeaders,
      durationMs: r.durationMs, error: r.error, responseBody: resRef,
    };
    const recBytes = serializedBytes(merged);
    if (recBytes > this.limits.maxRecordBytes) {
      // Oversize merge: drop the patch, keep the existing (request-only) record.
      releaseBodyRef(resRef, this.bodies);
      this.counters.rejectedRecords++; this.retentionDirty = true; this.flushRetention();
      return;
    }
    releaseBodyRef(existing.responseBody, this.bodies); // request ref carried over untouched
    this.metadataBytes -= this.entryMeta.get(key) ?? 0;
    this.entriesByKey.set(key, merged);
    this.entryMeta.set(key, recBytes);
    this.metadataBytes += recBytes;
    this.evictMetadata();
    this.emit('entry', storedToEntrySummary(merged));
    this.flushRetention();
  }

  // ---- WebSocket sessions -------------------------------------------------

  // Open (or confirm) a session under the admission authority. `via` says whether
  // this open is a real handshake (`open`) or driven by a first frame (`frame`,
  // which yields a partial session when the id was never handshaked). Returns the
  // admission outcome so the transport can close a connection on `overload`.
  addWsSession(w: WsSessionInput & { generation?: string; via?: 'open' | 'frame' }): AdmissionOutcome {
    const gen = w.generation ?? `legacy:${w.deviceId}`;
    const key = keyOf(w.deviceId, w.wsId);
    const outcome = this.admission.observe({ deviceId: w.deviceId, wsId: w.wsId }, gen, w.via ?? 'open');
    if (outcome === 'dropped' || outcome === 'overload') {
      // Refused outright: count it (distinct from an evicted session) and emit.
      this.counters.refusedSessions++; this.retentionDirty = true; this.flushRetention();
      return outcome;
    }
    if (this.sessionsByKey.has(key)) return outcome; // already retained (existing)

    const shell: Omit<WsSession, 'frames'> = {
      wsId: w.wsId, deviceId: w.deviceId, source: w.source, url: w.url, openedAt: w.openedAt,
      kind: w.kind ?? 'websocket', httpEntryKey: w.httpEntryKey ?? null,
      ...(outcome === 'partial' ? { partial: true } : {}),
      closedAt: w.closedAt ?? null, closeCode: w.closeCode ?? null, closeReason: w.closeReason ?? '',
    };
    const metaBytes = serializedBytes(shell);
    const ss: StoredSession = { session: shell, frames: [], metaBytes, generation: gen, nextSeq: 0, droppedLocal: 0 };
    this.sessionsByKey.set(key, ss);
    this.wsIdToKey.set(w.wsId, key);
    this.deviceSessions(w.deviceId).add(key);
    const sk = this.sessionSk(shell);
    this.sessionIndexGlobal.insert(sk, { deviceId: w.deviceId, id: w.wsId });
    this.deviceSessionIndex(w.deviceId).insert(sk, { deviceId: w.deviceId, id: w.wsId });
    this.metadataBytes += metaBytes;
    this.evictSessions(w.deviceId);
    this.evictMetadata();
    this.emit('ws', this.toWsSummary(ss));
    this.flushRetention();
    return outcome;
  }

  // Append one frame. `deviceId` routes by the composite (deviceId, wsId) so two
  // devices reusing a wsId never cross frames; `bytes` carries the raw payload when
  // the caller has it (binary frames from Atlantis), otherwise text is encoded from
  // `data`. A frame for a session that no longer exists (its open was dropped or it
  // was evicted/cleared) is counted as a dropped frame rather than silently ignored.
  appendWsFrame(wsId: string, f: { ts: number; direction: 'in' | 'out'; data: string | null; size: number; binary: boolean }, bytes?: Uint8Array | null, deviceId?: string): void {
    const key = deviceId != null ? keyOf(deviceId, wsId) : this.wsIdToKey.get(wsId);
    const ss = key ? this.sessionsByKey.get(key) : undefined;
    if (!key || !ss) { this.counters.droppedFrames++; this.retentionDirty = true; this.flushRetention(); return; }

    const gen = ss.generation;
    const outcome = this.admission.observe({ deviceId: ss.session.deviceId, wsId }, gen, 'frame');
    // A frame on a dropped id, or one that would overflow the generation registry,
    // is counted and NOT appended (never grow an unbounded queue for it).
    if (outcome === 'dropped' || outcome === 'overload') { this.counters.droppedFrames++; this.retentionDirty = true; this.flushRetention(); return; }

    const raw: Uint8Array | null = bytes != null ? bytes : (f.data != null ? Buffer.from(f.data, 'utf8') : null);
    // A binary frame whose bytes were dropped upstream for being over the per-message
    // cap reports 'size' (the over-cap reason), not 'binary'; a normal binary frame
    // (bytes present, or declared binary under the cap) keeps its binary nature. This
    // mirrors the over-cap text path, which surfaces 'size' via makeBodyRef.
    const declaredOmitted: BodyOmitted = f.binary
      ? (raw == null && f.size > this.limits.perWsMessageBytes ? 'size' : 'binary')
      : (raw == null ? 'not-captured' : null);
    const ref = makeBodyRef(raw, declaredOmitted, f.size, this.bodies, this.limits.perWsMessageBytes);
    this.countOmission(ref);
    const sequence = ss.nextSeq++;
    const frame: StoredFrame = { sequence, ts: f.ts, direction: f.direction, size: f.size, binary: f.binary, body: ref };
    const frameMeta = serializedBytes(frame);

    ss.frames.push(frame);
    ss.metaBytes += frameMeta;
    this.metadataBytes += frameMeta;
    this.totalFrames++;

    this.evictFrames(key, ss);
    this.evictMetadata();
    // Frame delta carries a FrameSummary (sequence + metadata + BodyRef), never
    // the payload bytes; the UI fetches the payload on demand by sequence. The
    // session's live counts ride along (evictFrames may have just trimmed the
    // oldest) so the client's retained count never drifts past the server's.
    this.emit('wsframe', {
      wsId, deviceId: ss.session.deviceId, frame: storedFrameToSummary(frame),
      retainedFrames: ss.frames.length, totalFrames: ss.nextSeq, droppedFrames: ss.droppedLocal,
    });
    this.flushRetention();
  }

  closeWs(wsId: string, ts: number, code: number, reason: string, deviceId?: string): void {
    const key = deviceId != null ? keyOf(deviceId, wsId) : this.wsIdToKey.get(wsId);
    const ss = key ? this.sessionsByKey.get(key) : undefined;
    if (!ss) return;
    this.metadataBytes -= ss.metaBytes;
    ss.session = { ...ss.session, closedAt: ts, closeCode: code, closeReason: reason };
    ss.metaBytes = serializedBytes(ss.session) + ss.frames.reduce((a, fr) => a + serializedBytes(fr), 0);
    this.metadataBytes += ss.metaBytes;
    this.emit('ws', this.toWsSummary(ss));
    this.flushRetention();
  }

  // Resolve a device key through the alias map (identity, when unaliased).
  resolveDeviceKey(deviceId: string): string { return this.aliases.get(deviceId) ?? deviceId; }

  // Record (or refresh) a device. `channel` names which capture channel this touch
  // arrived on: an `ingest` hello or an `atlantis` connection. The channel's
  // `lastSeenAt` is stamped and the record's `channels` merged with what was seen
  // before, so a phone heard on both channels carries both; `lastSeen` stays the
  // MAX across the incoming touch and the prior record so the liveness dot never
  // regresses when the quieter channel checks in.
  touchDevice(d: Device, channel?: 'ingest' | 'atlantis'): void {
    const id = this.resolveDeviceKey(d.deviceId);
    const existing = this.devs.get(id);
    const channels: DeviceChannels = { ...(existing?.channels ?? {}), ...(d.channels ?? {}) };
    if (channel) channels[channel] = { lastSeenAt: d.lastSeen };
    const lastSeen = existing ? Math.max(d.lastSeen, existing.lastSeen) : d.lastSeen;
    const merged: Device = { ...d, deviceId: id, lastSeen, channels };
    this.metadataBytes -= this.deviceMeta.get(id) ?? 0;
    this.devs.set(id, merged);
    const mb = serializedBytes(merged);
    this.deviceMeta.set(id, mb);
    this.metadataBytes += mb;
    this.evictMetadata();
    this.emit('device', merged);
    this.flushRetention();
  }

  // `generation` is the WSS connection's identity (from deviceServer), so session
  // admission is scoped to the connection and freed on socket close. Returns
  // 'overload' when a ws_open is refused for a full registry, so the transport can
  // close the responsible connection.
  applyDeviceMessage(deviceId: string, m: DeviceMessage, generation?: string): 'overload' | void {
    // The WSS/JS device path applies the collector's redaction to url, headers and
    // text bodies/frames BEFORE the bytes are hashed and stored, matching the
    // Atlantis (atlantis/decode.ts) and proxy (proxy/normalize.ts) paths — so the
    // BodyStore only ever hashes redacted bytes. Binary frame payloads are not
    // redacted as text (redactText only touches text).
    switch (m.type) {
      case 'hello': return this.touchDevice({ deviceId: m.deviceId, platform: m.platform, appVersion: m.appVersion, buildProfile: m.buildProfile, dropped: m.dropped, lastSeen: m.ts }, 'ingest');
      case 'request': return this.addEntry({ id: m.id, deviceId, source: 'xhr', startedAt: m.ts, method: m.method, url: redactUrl(m.url),
        requestHeaders: redactHeaders(m.headers), requestBody: redactText(m.body), requestBodySize: m.bodySize, requestBodyOmitted: m.bodyOmitted ?? null,
        status: null, statusText: '', responseHeaders: {}, responseBody: null, responseBodySize: 0, responseBodyOmitted: null, durationMs: null, error: null });
      case 'response': return this.patchEntryResponse(deviceId, m.id, { status: m.status, statusText: m.statusText, responseHeaders: redactHeaders(m.headers),
        responseBody: redactText(m.body), responseBodySize: m.bodySize, responseBodyOmitted: m.bodyOmitted ?? null, durationMs: m.durationMs, error: m.error ?? null });
      case 'ws_open': {
        const r = this.addWsSession({ wsId: m.wsId, deviceId, source: 'xhr', url: redactUrl(m.url), openedAt: m.ts, closedAt: null, closeCode: null, closeReason: '', generation });
        return r === 'overload' ? 'overload' : undefined;
      }
      case 'ws_frame': {
        // Text frames are redacted and the frame size recomputed from the redacted
        // bytes (as the proxy/Atlantis paths do); binary frames pass through untouched.
        const data = m.binary ? m.data : redactText(m.data);
        const size = !m.binary && data != null ? Buffer.byteLength(data, 'utf8') : m.size;
        return this.appendWsFrame(m.wsId, { ts: m.ts, direction: m.direction, data, size, binary: m.binary }, null, deviceId);
      }
      case 'ws_close': return this.closeWs(m.wsId, m.ts, m.code, m.reason, deviceId);
    }
  }

  // ---- Reads (materialize the legacy DTO) ---------------------------------

  entries(deviceId?: string): Entry[] {
    if (deviceId) {
      const set = this.entryDevice.get(deviceId);
      if (!set) return [];
      return [...set].map((k) => this.toEntry(this.entriesByKey.get(k)!));
    }
    // Global order by (startedAt, deviceId, id) via the index.
    const { keys } = this.entryIndexGlobal.page(null, this.entriesByKey.size);
    return keys.map((k) => this.toEntry(this.entriesByKey.get(keyOf(k.deviceId, k.id))!));
  }

  // Paged HTTP metadata (O03): a cursor query is a binary search plus a walk to
  // `limit`, never entries().sort().slice(). Returns legacy DTO entries.
  pageEntries(cursor: SortKey | null, limit: number, deviceId?: string): { entries: Entry[]; nextCursor: SortKey | null } {
    const index = deviceId ? this.entryIndexByDevice.get(deviceId) : this.entryIndexGlobal;
    if (!index) return { entries: [], nextCursor: null };
    const { keys, nextCursor } = index.page(cursor, limit);
    return { entries: keys.map((k) => this.toEntry(this.entriesByKey.get(keyOf(k.deviceId, k.id))!)), nextCursor };
  }

  wsSessions(deviceId?: string): WsSession[] {
    const keys = deviceId ? [...(this.sessionDevice.get(deviceId) ?? [])] : [...this.sessionsByKey.keys()];
    return keys.map((k) => this.toSession(this.sessionsByKey.get(k)!)).filter(Boolean) as WsSession[];
  }

  // ---- Export snapshot (R5) -----------------------------------------------

  // Acquire an immutable snapshot of the selected records for a streaming export.
  // The metadata is copied synchronously (so a later clear/upsert/eviction leaves
  // the snapshot intact) and every captured body it references is retained in the
  // BodyStore, so the bytes survive until `release()` even if the store drops the
  // record — and those retained bytes keep counting against the bodies budget, so
  // a capture arriving mid-export sees the same budget (export never relaxes it).
  // A 30 s deadline auto-releases the lease as a backstop against an abandoned
  // export; `release()` is idempotent.
  acquireExportSnapshot(selection: ExportSelection = {}): ExportSnapshot {
    const dev = selection.deviceId;
    const wantEntry = selection.entryKeys ? new Set(selection.entryKeys.map((k) => keyOf(k.deviceId, k.id))) : null;
    const wantWs = selection.wsKeys ? new Set(selection.wsKeys.map((k) => keyOf(k.deviceId, k.wsId))) : null;
    const retained: string[] = [];
    const retain = (ref: BodyRef): void => {
      if (ref.state === 'captured' && ref.sha256 && this.bodies.retain(ref.sha256)) retained.push(ref.sha256);
    };

    const entries: StoredEntry[] = [];
    for (const k of this.entryIndexGlobal.page(null, this.entriesByKey.size).keys) {
      if (dev && k.deviceId !== dev) continue;
      const key = keyOf(k.deviceId, k.id);
      if (wantEntry && !wantEntry.has(key)) continue;
      const s = this.entriesByKey.get(key);
      if (!s) continue;
      // Shallow copy with fresh BodyRef copies. The store replaces (never mutates)
      // a StoredEntry on upsert, so the copied refs stay valid; retaining pins the
      // bytes against a concurrent release.
      const copy: StoredEntry = { ...s, requestBody: { ...s.requestBody }, responseBody: { ...s.responseBody } };
      retain(copy.requestBody); retain(copy.responseBody);
      entries.push(copy);
    }

    const sessions: ExportSession[] = [];
    for (const k of this.sessionIndexGlobal.page(null, this.sessionsByKey.size).keys) {
      if (dev && k.deviceId !== dev) continue;
      const key = keyOf(k.deviceId, k.id);
      if (wantWs && !wantWs.has(key)) continue;
      const ss = this.sessionsByKey.get(key);
      if (!ss) continue;
      // The frame array IS mutated in place (push/shift on eviction), so snapshot a
      // copy of it; the frame objects themselves are never mutated after creation.
      const frames = ss.frames.slice();
      for (const fr of frames) retain(fr.body);
      sessions.push({
        ...ss.session, partial: ss.session.partial === true, frames,
        retainedFrames: frames.length, totalFrames: ss.nextSeq, droppedFrames: ss.droppedLocal,
      });
    }

    const bodies = this.bodies;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      for (const h of retained) bodies.release(h);
    };
    const timer = setTimeout(release, EXPORT_LEASE_MS);
    timer.unref?.();
    return { entries, sessions, readBody: (h) => bodies.read(h), release, deadlineAt: Date.now() + EXPORT_LEASE_MS };
  }

  // Newest-first entry SUMMARIES for the socket snapshot: identity + BodyRefs, no
  // body text and no BodyStore reads (O07). `max` caps how many are built.
  snapshotEntrySummaries(max = this.entriesByKey.size): EntrySummary[] {
    const { keys } = this.entryIndexGlobal.page(null, this.entriesByKey.size);
    const out: EntrySummary[] = [];
    for (let i = keys.length - 1; i >= 0 && out.length < max; i--) {
      const s = this.entriesByKey.get(keyOf(keys[i].deviceId, keys[i].id));
      if (s) out.push(storedToEntrySummary(s));
    }
    return out;
  }

  // Newest-first session SUMMARIES for the socket snapshot: counts, no frame array.
  snapshotWsSummaries(max = this.sessionsByKey.size): WsSummary[] {
    const { keys } = this.sessionIndexGlobal.page(null, this.sessionsByKey.size);
    const out: WsSummary[] = [];
    for (let i = keys.length - 1; i >= 0 && out.length < max; i--) {
      const ss = this.sessionsByKey.get(keyOf(keys[i].deviceId, keys[i].id));
      if (ss) out.push(this.toWsSummary(ss));
    }
    return out;
  }

  // ---- T09 metadata API (Page<Summary>, bodies fetched on demand) ---------

  // Walk an ordered index into a Page of items, bounded by 200 records / 1 MiB
  // serialized (first reached). `resolve` yields the item and its stable SortKey;
  // the returned cursor is the key of the LAST INCLUDED item so the next page
  // resumes strictly after it — a record appearing mid-walk never repeats.
  private pageIndex<T>(index: SortedKeyIndex | undefined, cursorRaw: string | null | undefined,
    maxRecords: number, resolve: (k: EntryKey) => { sk: SortKey; item: T } | undefined): Page<T> {
    if (!index) return { items: [], nextCursor: null };
    const cap = Math.min(Math.max(1, maxRecords), PAGE_MAX_RECORDS);
    const cursor = decodeCursor(cursorRaw);
    const items: T[] = [];
    let used = 2; // "[]"
    let cur = cursor;
    let nextSk: SortKey | null = null;
    outer: for (;;) {
      const page = index.page(cur, 50);
      if (page.keys.length === 0) { nextSk = null; break; }
      for (const k of page.keys) {
        const r = resolve(k);
        if (!r) continue;
        const size = Buffer.byteLength(JSON.stringify(r.item)) + 1;
        if (items.length >= cap || (items.length > 0 && used + size > PAGE_MAX_BYTES)) break outer;
        items.push(r.item); used += size; nextSk = r.sk;
      }
      cur = page.nextCursor;
      if (cur === null) { nextSk = null; break; }
    }
    return { items, nextCursor: encodeCursor(nextSk) };
  }

  // GET /api/entries — paged entry summaries (identity + BodyRefs, no headers/bytes).
  entrySummaryPage(cursorRaw?: string | null, deviceId?: string, limit = PAGE_MAX_RECORDS): Page<EntrySummary> {
    const index = deviceId ? this.entryIndexByDevice.get(deviceId) : this.entryIndexGlobal;
    return this.pageIndex<EntrySummary>(index, cursorRaw, limit, (k) => {
      const s = this.entriesByKey.get(keyOf(k.deviceId, k.id));
      return s ? { sk: this.entrySk(s), item: storedToEntrySummary(s) } : undefined;
    });
  }

  // GET /api/ws — paged session summaries; the frame ARRAY is replaced by counts.
  wsSummaryPage(cursorRaw?: string | null, deviceId?: string, limit = PAGE_MAX_RECORDS): Page<WsSummary> {
    const index = deviceId ? this.sessionIndexByDevice.get(deviceId) : this.sessionIndexGlobal;
    return this.pageIndex<WsSummary>(index, cursorRaw, limit, (k) => {
      const ss = this.sessionsByKey.get(keyOf(k.deviceId, k.id));
      return ss ? { sk: this.sessionSk(ss.session), item: this.toWsSummary(ss) } : undefined;
    });
  }

  // GET /api/devices — devices paged lexicographically by id (opaque cursor is the
  // last id returned), bounded by the same record/byte budget.
  devicePage(cursorRaw?: string | null, limit = PAGE_MAX_RECORDS): Page<UiDevice> {
    const after = cursorRaw ? (() => { try { return Buffer.from(cursorRaw, 'base64url').toString('utf8'); } catch { return null; } })() : null;
    const ids = [...this.devs.keys()].sort();
    const items: UiDevice[] = [];
    let used = 2; let last: string | null = null;
    const cap = Math.min(limit, PAGE_MAX_RECORDS);
    for (const id of ids) {
      if (after !== null && id <= after) continue;
      const d = this.devs.get(id)!;
      const size = Buffer.byteLength(JSON.stringify(d)) + 1;
      if (items.length >= cap || (items.length > 0 && used + size > PAGE_MAX_BYTES)) break;
      items.push(d); used += size; last = id;
    }
    const more = last !== null && ids.some((id) => id > last!);
    return { items, nextCursor: more && last !== null ? Buffer.from(last).toString('base64url') : null };
  }

  // GET /api/entries/:device/:id — full detail (headers + BodyRefs), no body bytes.
  entryDetail(deviceId: string, id: string): EntryDetail | null {
    const s = this.entriesByKey.get(keyOf(deviceId, id));
    return s ? storedToEntryDetail(s) : null;
  }

  // GET /api/entries/:device/:id/body?side= — the bytes (or omission) of one body.
  // null means the entry itself is unknown (404); otherwise the caller maps the
  // BodyBytes.state to 200 (absent/captured) or 410 (omitted).
  entryBody(deviceId: string, id: string, side: 'request' | 'response'): BodyBytes | null {
    const s = this.entriesByKey.get(keyOf(deviceId, id));
    if (!s) return null;
    return readBodyBytes(side === 'request' ? s.requestBody : s.responseBody, this.bodies);
  }

  // GET /api/ws/:device/:wsId/frames?after&limit — frames with sequence > `after`,
  // as summaries (metadata + BodyRef). null when the session is unknown (404).
  wsFramesPage(deviceId: string, wsId: string, after: number | null, limit = PAGE_MAX_RECORDS): Page<FrameSummary> | null {
    const ss = this.sessionsByKey.get(keyOf(deviceId, wsId));
    if (!ss) return null;
    const items: FrameSummary[] = [];
    let used = 2; let last: number | null = null;
    const cap = Math.min(limit, PAGE_MAX_RECORDS);
    for (const fr of ss.frames) {
      if (after !== null && fr.sequence <= after) continue;
      const item = storedFrameToSummary(fr);
      const size = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (items.length >= cap || (items.length > 0 && used + size > PAGE_MAX_BYTES)) break;
      items.push(item); used += size; last = fr.sequence;
    }
    const more = last !== null && ss.frames.some((fr) => fr.sequence > last!);
    return { items, nextCursor: more && last !== null ? String(last) : null };
  }

  // GET /api/ws/:device/:wsId/frames/:sequence/body — one frame's payload bytes.
  // null when the session or the frame sequence is unknown (404).
  frameBody(deviceId: string, wsId: string, sequence: number): BodyBytes | null {
    const ss = this.sessionsByKey.get(keyOf(deviceId, wsId));
    if (!ss) return null;
    const fr = ss.frames.find((f) => f.sequence === sequence);
    if (!fr) return null;
    return readBodyBytes(fr.body, this.bodies);
  }

  private toWsSummary(ss: StoredSession): WsSummary {
    return {
      ...ss.session, partial: ss.session.partial === true,
      retainedFrames: ss.frames.length, totalFrames: ss.nextSeq, droppedFrames: ss.droppedLocal,
    };
  }

  // Release a connection generation's session-admission registry when its
  // transport closes (O04), so tombstones do not accumulate indefinitely.
  closeWsGeneration(generation: string): void { this.admission.closeGeneration(generation); }

  devices(): Device[] { return [...this.devs.values()]; }
  atMax(): boolean { return this.capped; }
  // Effective metadata footprint: record serialization PLUS the session-admission
  // registry (admitted ids + tombstones), which the brief counts inside the 32 MiB
  // metadata budget.
  private effectiveMetadataBytes(): number { return this.metadataBytes + this.admission.registryBytes(); }
  retentionCounters(): RetentionCounters { return { ...this.counters, retainedBodyBytes: this.bodies.stats().retainedBytes, retainedMetadataBytes: this.effectiveMetadataBytes() }; }
  bodyStats() { return this.bodies.stats(); }

  clear(deviceId?: string): void {
    if (deviceId) {
      const removedEntries: EntryKey[] = [];
      for (const k of this.entryDevice.get(deviceId) ?? []) { this.dropEntryKey(k, removedEntries); }
      const removedSessions: WsKey[] = [];
      for (const k of [...(this.sessionDevice.get(deviceId) ?? [])]) { this.dropSessionKey(k, removedSessions); }
      this.entryDevice.delete(deviceId); this.sessionDevice.delete(deviceId);
      this.entryIndexByDevice.delete(deviceId); this.sessionIndexByDevice.delete(deviceId);
      // Reclaim this device's admission capacity so a long-lived connection is not
      // wedged in permanent overload after the UI clears it.
      this.admission.resetDevice(deviceId);
      if (removedEntries.length) this.emit('entries_removed', { keys: removedEntries });
      if (removedSessions.length) this.emit('sessions_removed', { keys: removedSessions });
    } else {
      for (const ss of this.sessionsByKey.values()) for (const fr of ss.frames) releaseBodyRef(fr.body, this.bodies);
      for (const e of this.entriesByKey.values()) { releaseBodyRef(e.requestBody, this.bodies); releaseBodyRef(e.responseBody, this.bodies); }
      this.entriesByKey.clear(); this.entryMeta.clear(); this.entryDevice.clear();
      this.entryIndexGlobal.clear(); this.entryIndexByDevice.clear();
      this.sessionsByKey.clear(); this.wsIdToKey.clear(); this.sessionDevice.clear();
      this.sessionIndexGlobal.clear(); this.sessionIndexByDevice.clear(); this.totalFrames = 0;
      this.metadataBytes = 0; this.capped = false;
      this.admission.reset();
    }
    this.retentionDirty = true;
    this.emit('clear', deviceId ?? null);
    this.flushRetention();
  }

  // ---- Internals ----------------------------------------------------------

  private entrySk(e: { startedAt: number; deviceId: string; id: string }): SortKey { return [e.startedAt, e.deviceId, e.id]; }
  private sessionSk(s: { openedAt: number; deviceId: string; wsId: string }): SortKey { return [s.openedAt, s.deviceId, s.wsId]; }
  private deviceEntries(d: string): Set<string> { let s = this.entryDevice.get(d); if (!s) { s = new Set(); this.entryDevice.set(d, s); } return s; }
  private deviceEntryIndex(d: string): SortedKeyIndex { let i = this.entryIndexByDevice.get(d); if (!i) { i = new SortedKeyIndex(); this.entryIndexByDevice.set(d, i); } return i; }
  private deviceSessions(d: string): Set<string> { let s = this.sessionDevice.get(d); if (!s) { s = new Set(); this.sessionDevice.set(d, s); } return s; }
  private deviceSessionIndex(d: string): SortedKeyIndex { let i = this.sessionIndexByDevice.get(d); if (!i) { i = new SortedKeyIndex(); this.sessionIndexByDevice.set(d, i); } return i; }

  private countOmission(ref: BodyRef): void { if (ref.state === 'omitted') { this.counters.omittedBodies++; this.retentionDirty = true; } }

  private toEntry(s: StoredEntry): Entry { return storedToEntry(s, this.bodies); }
  private toFrame(fr: StoredFrame): WsSession['frames'][number] {
    if (fr.body.state === 'captured' && fr.body.encoding === 'utf8' && fr.body.sha256) {
      const bytes = this.bodies.read(fr.body.sha256);
      return { ts: fr.ts, direction: fr.direction, data: bytes ? Buffer.from(bytes).toString('utf8') : null, size: fr.size, binary: fr.binary };
    }
    return { ts: fr.ts, direction: fr.direction, data: null, size: fr.size, binary: fr.binary };
  }
  private toSession(ss: StoredSession): WsSession { return { ...ss.session, frames: ss.frames.map((fr) => this.toFrame(fr)) }; }

  private markCapped(): void { if (!this.capped) { this.capped = true; this.emit('atmax', true); } }

  // Evict oldest HTTP entries (admission order) until per-device and global caps
  // hold; emit the removed keys.
  private evictEntries(deviceId: string): void {
    const removed: EntryKey[] = [];
    const devSet = this.entryDevice.get(deviceId);
    while (devSet && devSet.size > this.limits.httpPerDevice) { this.dropOldestEntry(devSet, removed); this.markCapped(); }
    while (this.entriesByKey.size > this.limits.httpGlobal) {
      const oldest = this.entriesByKey.keys().next().value as string | undefined;
      if (!oldest) break;
      this.dropEntryKey(oldest, removed); this.markCapped();
    }
    if (removed.length) this.emit('entries_removed', { keys: removed });
  }

  private dropOldestEntry(devSet: Set<string>, removed: EntryKey[]): void {
    const oldest = devSet.values().next().value as string | undefined;
    if (oldest) this.dropEntryKey(oldest, removed);
  }

  private dropEntryKey(key: string, removed: EntryKey[]): void {
    const stored = this.entriesByKey.get(key);
    if (!stored) return;
    releaseBodyRef(stored.requestBody, this.bodies);
    releaseBodyRef(stored.responseBody, this.bodies);
    this.metadataBytes -= this.entryMeta.get(key) ?? 0;
    this.entryMeta.delete(key);
    this.entriesByKey.delete(key);
    this.entryDevice.get(stored.deviceId)?.delete(key);
    const sk = this.entrySk(stored);
    this.entryIndexGlobal.remove(sk);
    this.entryIndexByDevice.get(stored.deviceId)?.remove(sk);
    this.counters.droppedEntries++;
    this.retentionDirty = true;
    removed.push({ deviceId: stored.deviceId, id: stored.id });
  }

  private evictSessions(deviceId: string): void {
    const removed: WsKey[] = [];
    const devSet = this.sessionDevice.get(deviceId);
    while (devSet && devSet.size > this.limits.wsSessionsPerDevice) {
      const oldest = devSet.values().next().value as string | undefined;
      if (!oldest) break; this.dropSessionKey(oldest, removed);
    }
    while (this.sessionsByKey.size > this.limits.wsSessionsGlobal) {
      const oldest = this.sessionsByKey.keys().next().value as string | undefined;
      if (!oldest) break; this.dropSessionKey(oldest, removed);
    }
    if (removed.length) this.emit('sessions_removed', { keys: removed });
  }

  private dropSessionKey(key: string, removed: WsKey[]): void {
    const ss = this.sessionsByKey.get(key);
    if (!ss) return;
    for (const fr of ss.frames) releaseBodyRef(fr.body, this.bodies);
    this.totalFrames -= ss.frames.length;
    this.metadataBytes -= ss.metaBytes;
    this.sessionsByKey.delete(key);
    if (this.wsIdToKey.get(ss.session.wsId) === key) this.wsIdToKey.delete(ss.session.wsId);
    this.sessionDevice.get(ss.session.deviceId)?.delete(key);
    const sk = this.sessionSk(ss.session);
    this.sessionIndexGlobal.remove(sk);
    this.sessionIndexByDevice.get(ss.session.deviceId)?.remove(sk);
    this.admission.markRemoved({ deviceId: ss.session.deviceId, wsId: ss.session.wsId });
    this.counters.droppedSessions++;
    this.retentionDirty = true;
    removed.push({ deviceId: ss.session.deviceId, wsId: ss.session.wsId });
  }

  // Evict oldest frames of a session, then oldest frames globally.
  private evictFrames(key: string, ss: StoredSession): void {
    while (ss.frames.length > this.limits.wsMessagesPerSession) this.dropOldestFrame(ss);
    while (this.totalFrames > this.limits.wsMessagesGlobal) {
      // Oldest frame across all sessions: the oldest session that still has frames.
      let target: StoredSession | undefined;
      for (const s of this.sessionsByKey.values()) { if (s.frames.length > 0) { target = s; break; } }
      if (!target) break;
      this.dropOldestFrame(target);
    }
    void key;
  }

  private dropOldestFrame(ss: StoredSession): void {
    const fr = ss.frames.shift();
    if (!fr) return;
    releaseBodyRef(fr.body, this.bodies);
    const fm = serializedBytes(fr);
    ss.metaBytes -= fm; this.metadataBytes -= fm;
    this.totalFrames--;
    ss.droppedLocal++;
    this.counters.droppedFrames++;
    this.retentionDirty = true;
  }

  // Secondary guard: when total metadata exceeds its budget, evict oldest records
  // (entries, then sessions, then historical devices) until it fits.
  private evictMetadata(): void {
    if (this.effectiveMetadataBytes() <= this.limits.metadataBytes) return;
    const removedEntries: EntryKey[] = [];
    const removedSessions: WsKey[] = [];
    while (this.effectiveMetadataBytes() > this.limits.metadataBytes && this.entriesByKey.size > 0) {
      const oldest = this.entriesByKey.keys().next().value as string; this.dropEntryKey(oldest, removedEntries); this.markCapped();
    }
    while (this.effectiveMetadataBytes() > this.limits.metadataBytes && this.sessionsByKey.size > 0) {
      const oldest = this.sessionsByKey.keys().next().value as string; this.dropSessionKey(oldest, removedSessions);
    }
    while (this.effectiveMetadataBytes() > this.limits.metadataBytes && this.devs.size > 0) {
      // Historical devices with no live records go last.
      const oldest = this.devs.keys().next().value as string;
      this.metadataBytes -= this.deviceMeta.get(oldest) ?? 0;
      this.deviceMeta.delete(oldest); this.devs.delete(oldest);
    }
    if (removedEntries.length) this.emit('entries_removed', { keys: removedEntries });
    if (removedSessions.length) this.emit('sessions_removed', { keys: removedSessions });
  }

  // Emit a `retention` event only when this operation actually dropped or omitted
  // something, so a clean add is a single `entry` delta (not entry + retention).
  private flushRetention(): void {
    if (!this.retentionDirty) return;
    this.retentionDirty = false;
    const c = this.retentionCounters();
    this.counters.retainedBodyBytes = c.retainedBodyBytes;
    this.counters.retainedMetadataBytes = c.retainedMetadataBytes;
    this.emit('retention', {
      type: 'retention',
      retainedBodyBytes: c.retainedBodyBytes, retainedMetadataBytes: c.retainedMetadataBytes,
      droppedEntries: c.droppedEntries, droppedSessions: c.droppedSessions,
      droppedFrames: c.droppedFrames, omittedBodies: c.omittedBodies, refusedSessions: c.refusedSessions,
      rejectedRecords: c.rejectedRecords,
    });
  }
}
