export type Hello = { type: 'hello'; deviceId: string; platform: 'android' | 'ios';
  appVersion: string; buildProfile: string; dropped: number; ts: number;
  // Optional: the key the Atlantis SDK will present under, when the app knows it.
  // Lets the collector alias Atlantis traffic onto this hello's deviceId even when
  // the SDK is too old to be started with the app's own id.
  atlantisDeviceKey?: string };
export type RequestEvent = { type: 'request'; id: string; ts: number; method: string;
  url: string; headers: Record<string, string>; body: string | null;
  bodyOmitted?: 'size' | 'binary'; bodySize: number; source: 'xhr' };
export type ResponseEvent = { type: 'response'; id: string; ts: number; status: number;
  statusText: string; headers: Record<string, string>; body: string | null;
  bodyOmitted?: 'size' | 'binary'; bodySize: number; durationMs: number;
  error?: 'network' | 'timeout' | 'abort' };
export type WsOpen = { type: 'ws_open'; wsId: string; ts: number; url: string; protocols: string[] };
export type WsFrame = { type: 'ws_frame'; wsId: string; ts: number; direction: 'in' | 'out';
  data: string | null; size: number; binary: boolean };
export type WsClose = { type: 'ws_close'; wsId: string; ts: number; code: number; reason: string };
export type DeviceMessage = Hello | RequestEvent | ResponseEvent | WsOpen | WsFrame | WsClose;

// `xhr` and `atlantis` are the two app-side capture channels; `proxy` (R4/T11) is
// the additive MITM-proxy source. A proxy sees the SAME request Atlantis/patchWS
// already reported as a SECOND, independent piece of evidence — the sources are
// never merged, so `source` is what the UI/HAR filter on to tell them apart.
export type Source = 'xhr' | 'atlantis' | 'proxy';

// Why a body is not carried as recoverable bytes. `size`/`binary` are the legacy
// DTO markers the UI still understands; `budget` marks a body dropped because the
// bodies budget was full; `not-captured` marks a body the origin never sent us.
export type BodyOmission = 'size' | 'binary' | 'budget' | 'not-captured';
export type BodyOmitted = BodyOmission | null;

// A reference from a stored record to the immutable bytes held in the BodyStore.
// The store — never the record — owns those bytes; a record only holds this ref.
//   absent   : no body at all (a GET with no request body); size/storedSize 0.
//   captured : bytes retained under `sha256`; `size` is the original byte length,
//              `storedSize` the retained length, `encoding` how to materialize it.
//   omitted  : a body existed but was not retained (`omitted` says why); no hash,
//              storedSize 0, `size` the original length when known else null.
export type BodyRef = {
  state: 'absent' | 'captured' | 'omitted';
  sha256: string | null;
  size: number | null; // original size unknown stays null
  storedSize: number;
  encoding: 'utf8' | 'binary';
  omitted: BodyOmission | null;
};

// The compatibility DTO handed to the UI, HTTP and HAR layers. It is NOT the
// internal record: bodies are materialized text (or null), reconstructed on
// demand from the BodyStore. T09 removes the last of the text-DTO adapter.
export type Entry = {
  id: string; deviceId: string; source: Source;
  startedAt: number; // ms epoch
  method: string; url: string;
  requestHeaders: Record<string, string>; requestBody: string | null; requestBodySize: number; requestBodyOmitted: BodyOmitted;
  status: number | null; statusText: string;
  responseHeaders: Record<string, string>; responseBody: string | null; responseBodySize: number; responseBodyOmitted: BodyOmitted;
  durationMs: number | null;
  error: string | null;
};

// Ingest input for a captured exchange: everything of `Entry` except the text
// bodies, plus the raw (already-redacted) bytes the store hashes and retains.
// `requestBodySize`/`requestBodyOmitted` still travel so the store can tell an
// absent body from an omitted one when no bytes are present.
export type EntryInput = Omit<Entry, 'requestBody' | 'responseBody'> & {
  requestBytes: Uint8Array | null; responseBytes: Uint8Array | null;
};

// Composite identity used by removal events and the pagination index; mirrors
// the UI protocol's EntryKey/WsKey so both sides agree on what a key is.
export type EntryKey = { deviceId: string; id: string };
export type WsKey = { deviceId: string; wsId: string };

// A stored WebSocket frame: its metadata plus a body reference to the (bounded)
// payload bytes. `binary` marks a frame whose bytes are not UTF-8 text.
// `sequence` is the session-monotonic index assigned at append time; it survives
// frame eviction (so gaps are visible) and is the cursor for paged frame reads.
export type StoredFrame = { sequence: number; ts: number; direction: 'in' | 'out'; size: number; binary: boolean; body: BodyRef };

// A stored HTTP exchange, holding body references rather than text.
export type StoredEntry = Omit<Entry, 'requestBody' | 'responseBody' |
  'requestBodySize' | 'responseBodySize' | 'requestBodyOmitted' | 'responseBodyOmitted'> & {
  requestBody: BodyRef; responseBody: BodyRef;
};

// A captured WebSocket session. `kind` separates a real socket from an SSE stream
// tunnelled over the same machinery; `httpEntryKey` links an SSE stream back to
// the HTTP exchange that carries it (null for a plain socket).
export type WsSession = {
  wsId: string; deviceId: string; source: Source; url: string; openedAt: number;
  kind: 'websocket' | 'sse'; httpEntryKey: EntryKey | null;
  // `partial` marks a session the admission authority opened from an orphan frame
  // or reopened after a gap (a removal), so the UI can flag the missing prefix.
  partial?: boolean;
  frames: { ts: number; direction: 'in' | 'out'; data: string | null; size: number; binary: boolean }[];
  closedAt: number | null; closeCode: number | null; closeReason: string;
};

// Input shape for opening a session; `kind`/`httpEntryKey` and the close fields
// default so the legacy text-DTO callers (fixtures, WSS ingest) need not spell
// them out.
export type WsSessionInput = Omit<WsSession, 'kind' | 'httpEntryKey' | 'frames' | 'closedAt' | 'closeCode' | 'closeReason'> &
  Partial<Pick<WsSession, 'kind' | 'httpEntryKey' | 'closedAt' | 'closeCode' | 'closeReason'>> & { frames?: WsSession['frames'] };

// The two device-side capture channels a single phone can present on: `ingest` is
// the JS/WSS hello+messages channel (deviceServer), `atlantis` the Atlantis SDK
// TLS channel (atlantis/server connection+traffic). Each records when it was last
// heard from; `Device.lastSeen` stays the max across both.
export type DeviceChannel = { lastSeenAt: number };
export type DeviceChannels = { ingest?: DeviceChannel; atlantis?: DeviceChannel };

export type Device = { deviceId: string; platform: string; appVersion: string;
  buildProfile: string; dropped: number; lastSeen: number;
  // Additive (protocol v3): present once a channel has been observed; absent on
  // legacy records so pre-channels snapshots and fixtures still type-check.
  channels?: DeviceChannels };

// ---- Export snapshot (R5) -----------------------------------------------
// An export names what to include: a whole device (or all devices when
// `deviceId` is absent), or an explicit set of composite keys. `entryKeys` and
// `wsKeys`, when given, further narrow the selection; absent means "all of that
// kind within the device scope".
export type ExportSelection = { deviceId?: string; entryKeys?: EntryKey[]; wsKeys?: WsKey[] };

// One WS session as it appears in an export snapshot: the immutable session
// shell plus a frozen copy of its frame array (metadata + BodyRefs) and the live
// frame counts at snapshot time.
export type ExportSession = Omit<WsSession, 'frames'> & {
  frames: StoredFrame[];
  retainedFrames: number; totalFrames: number; droppedFrames: number;
};

// An immutable, point-in-time view of selected records for a streaming export.
// It holds its own BodyStore references (acquired at snapshot time) so a
// concurrent clear/upsert/eviction cannot free the bytes it will stream; those
// references count against the bodies budget until `release()`. Body bytes are
// fetched one at a time via `readBody(hash)` — the snapshot never materializes
// them all. The lease auto-releases at `deadlineAt` (≤30 s) as a backstop.
export interface ExportSnapshot {
  entries: StoredEntry[];
  sessions: ExportSession[];
  readBody(hash: string): Uint8Array | undefined;
  release(): void;
  readonly deadlineAt: number; // epoch ms after which the lease self-releases
}

export function isDeviceMessage(x: unknown): x is DeviceMessage {
  if (!x || typeof x !== 'object') return false;
  const m = x as Record<string, unknown>;
  const str = (k: string) => typeof m[k] === 'string';
  const num = (k: string) => typeof m[k] === 'number' && Number.isFinite(m[k]);
  switch (m.type) {
    case 'hello': return str('deviceId') && str('platform') && str('appVersion') && str('buildProfile') && num('dropped') && num('ts')
      && (m.atlantisDeviceKey === undefined || typeof m.atlantisDeviceKey === 'string');
    case 'request': return str('id') && num('ts') && str('method') && str('url') && num('bodySize');
    case 'response': return str('id') && num('ts') && num('status') && num('bodySize') && num('durationMs');
    case 'ws_open': return str('wsId') && num('ts') && str('url');
    case 'ws_frame': return str('wsId') && num('ts') && (m.direction === 'in' || m.direction === 'out') && num('size');
    case 'ws_close': return str('wsId') && num('ts') && num('code');
    default: return false;
  }
}
