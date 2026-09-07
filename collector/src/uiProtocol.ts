// Shared UI protocol (v2). Importable in the browser: types plus pure helpers,
// with no Node dependencies. Server and client are published together and
// identified by protocolVersion 2. T02 centralises today's messages; T08/T09
// evolve this same contract into summaries without dropping the caps.
import type { Entry, WsSession, Device, BodyRef } from './types.js';

export type { Entry, WsSession, Device, BodyRef, BodyOmitted, BodyOmission } from './types.js';

export const PROTOCOL_VERSION = 3;

// ---- T09 HTTP metadata contract ------------------------------------------
// The `/api/*` metadata endpoints speak these summary shapes: identity plus
// bounded metadata and a BodyRef (hash + size + omission), never body bytes or
// text and never an unbounded array. Body bytes are fetched on demand from the
// dedicated `/body` routes, keyed by the ref's sha256 so the browser can cache a
// formatted representation without re-parsing. Frame lists are paged, never
// carried whole. `nextCursor` is an opaque base64url string; null when exhausted.
export type Page<T> = { items: T[]; nextCursor: string | null };

// One HTTP exchange as it appears in a metadata page: no headers (the detail
// route carries those), no body bytes — only the two body references.
export type EntrySummary = Pick<Entry, 'id' | 'deviceId' | 'source' | 'startedAt' |
  'method' | 'url' | 'status' | 'durationMs' | 'error'> & {
  requestBody: BodyRef; responseBody: BodyRef;
  // Set by the fanout when a device-supplied identity string (id/url/…) exceeded
  // the message cap and was clipped; the record is otherwise intact.
  identityClipped?: true;
};

// The detail route adds the headers and statusText the summary omits, still
// without materializing any body — bodies come from `/body`.
export type EntryDetail = EntrySummary & {
  requestHeaders: Record<string, string>; responseHeaders: Record<string, string>; statusText: string;
};

// A WebSocket session in a metadata page: the frame ARRAY is replaced by counts
// (frames are paged via `/frames`), so a long-lived session never balloons the
// page. `partial` is normalised to a boolean (a resumed/orphaned prefix).
export type WsSummary = Omit<WsSession, 'frames' | 'partial'> & {
  retainedFrames: number; totalFrames: number; droppedFrames: number; partial: boolean;
  identityClipped?: true;
};

// One frame in a paged frame listing: its stable monotonic `sequence` (the
// `after` cursor), metadata, and a BodyRef — the payload is fetched by sequence.
export type FrameSummary = {
  sequence: number; ts: number; direction: 'in' | 'out';
  binary: boolean; body: BodyRef;
};

// A device as it travels to the UI. Every field of `Device` is device-supplied
// and unbounded at ingest, so a device can be clipped exactly like a summary —
// in a `device` delta and in the snapshot baseline alike. `identityClipped` marks
// a carrier whose strings the fanout clipped to a bounded length.
export type UiDevice = Device & { identityClipped?: true };

// Incremental frame envelope. Flat by design: the generic wrapper
// send('ws_frame','frame') nested the payload a level too deep and dropped the
// {wsId,deviceId} the client needs to locate the session. The composite key
// below keeps ids from colliding across devices/sources.
// The session's live frame counts ride on every frame delta so the UI stays
// exact as frames evict — frame eviction emits no separate `ws` update, so
// without these the client's retained count would drift upward past the server's.
export type WsFrameEvent<F> = {
  type: 'ws_frame'; wsId: string; deviceId: string; frame: F;
  retainedFrames: number; totalFrames: number; droppedFrames: number;
};

export type EntryKey = { deviceId: string; id: string };
export type WsKey = { deviceId: string; wsId: string };
export const entityKey = (deviceId: string, id: string) =>
  JSON.stringify([deviceId, id]);

// Snapshot v2 (T09): the socket carries the SAME summary DTOs as the HTTP
// metadata routes — never body bytes/text, never an unbounded frame array.
// `entries`/`ws` are `Page`s (first, newest window; older records via /api/*),
// `devices` is bounded, and the retention totals ride along so a reconnecting
// client has them immediately. `truncated` is set when the newest window did not
// fit under the message cap and the oldest were dropped.
// `paused` (v3) reports whether the broadcaster is currently suppressing live
// deltas, so a reconnecting or resyncing client renders the pause indicator
// immediately instead of waiting for a `paused` delta.
export type SnapshotMessage = {
  type: 'snapshot'; devices: UiDevice[];
  entries: Page<EntrySummary>; ws: Page<WsSummary>;
  retention: Omit<RetentionMessage, 'type'> | null;
  atMax: boolean; truncated: boolean; paused: boolean;
  // The server's PROTOCOL_VERSION, stamped on every snapshot so a reconnecting
  // client can warn once when it is talking to a server it does not match.
  // Optional so pre-v3 snapshots (and existing test fixtures) still type-check.
  protocolVersion?: number;
};
// Incremental deltas carry summaries only: a BodyRef (hash + size + omission),
// never the body text; a FrameSummary (sequence + metadata), never the payload.
// The UI fetches bodies/frame payloads on demand from the `/api/*` routes.
export type EntryMessage = { type: 'entry'; entry: EntrySummary };
export type WsMessage = { type: 'ws'; session: WsSummary };
export type DeviceUpdate = { type: 'device'; device: UiDevice };
export type AtMaxMessage = { type: 'atmax'; atMax: boolean };
// Live-stream pause toggle (v3): while `paused` is true the broadcaster drops
// every store delta (the store keeps recording); resume replays a fresh snapshot.
export type PausedMessage = { type: 'paused'; paused: boolean };
export type ClearMessage = { type: 'clear'; deviceId: string | null };

// Retention removals and totals (T08). `entries_removed`/`sessions_removed` name
// the composite keys the store evicted (oldest-first) so the UI drops them
// without a full resync; `retention` reports the current retained bytes and the
// cumulative drop counters, including partial sessions and dropped frames.
export type EntriesRemovedMessage = { type: 'entries_removed'; keys: EntryKey[] };
export type SessionsRemovedMessage = { type: 'sessions_removed'; keys: WsKey[] };
export type RetentionMessage = {
  type: 'retention'; retainedBodyBytes: number; retainedMetadataBytes: number;
  droppedEntries: number; droppedSessions: number; droppedFrames: number; omittedBodies: number;
  // Sessions the admission authority refused outright (late frame after removal, or
  // registry full) — distinct from `droppedSessions` (retained-then-evicted).
  refusedSessions: number;
  // HTTP records rejected whole because their metadata alone exceeded
  // `maxRecordBytes` (64 KiB); no bytes were retained for them.
  rejectedRecords: number;
};

export type UiMessage =
  | SnapshotMessage | EntryMessage | WsMessage | WsFrameEvent<FrameSummary>
  | DeviceUpdate | AtMaxMessage | ClearMessage | PausedMessage
  | EntriesRemovedMessage | SessionsRemovedMessage | RetentionMessage;

// Serialized-size ceiling for any single UI message, snapshot included. It
// bounds the fanout budget per message; T09 paginates payloads that would
// exceed it rather than lifting the cap.
export const MAX_UI_MESSAGE_BYTES = 2 * 1024 * 1024;
