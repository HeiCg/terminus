import type { Entry, EntryInput, StoredEntry, StoredFrame, BodyRef, BodyOmitted } from './types.js';
import type { BodyStore } from './bodyStore.js';
import type { EntrySummary, EntryDetail, FrameSummary } from './uiProtocol.js';

// The bytes (or omission) behind one BodyRef, read on demand for the `/body`
// routes. `state` maps directly to an HTTP status: 'absent'/'captured' → 200
// (captured carries the bytes, absent is an empty body), 'omitted' → 410 with
// `omitted` as the reason. Never materialized into the summary/detail DTOs.
export type BodyBytes = { state: BodyRef['state']; bytes: Uint8Array | null; encoding: BodyRef['encoding']; omitted: BodyRef['omitted']; size: number };

export function readBodyBytes(ref: BodyRef, bodies: BodyStore): BodyBytes {
  const size = ref.size ?? ref.storedSize;
  if (ref.state === 'captured' && ref.sha256) {
    const bytes = bodies.read(ref.sha256) ?? new Uint8Array(0);
    return { state: 'captured', bytes, encoding: ref.encoding, omitted: null, size };
  }
  return { state: ref.state, bytes: ref.state === 'absent' ? new Uint8Array(0) : null, encoding: ref.encoding, omitted: ref.omitted, size };
}

// Adapters between the three representations of a captured body:
//   - the legacy text DTO (`Entry`) the UI/HTTP/HAR still speak;
//   - the ingest input (`EntryInput`) carrying raw redacted bytes;
//   - the internal `StoredEntry` holding only BodyRefs into the BodyStore.
// The store is the single owner of body references: every ref a `makeBodyRef`
// hands back already holds one BodyStore reference, and the store must release
// it on removal, eviction or when a body is replaced by an upsert.

const ABSENT: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };

// Build a BodyRef from ingest input, acquiring bytes into the BodyStore when they
// fit. `declaredOmitted === 'binary'` with bytes present marks a captured binary
// body (its bytes are preserved and recoverable); other omissions carry no bytes.
export function makeBodyRef(
  bytes: Uint8Array | null,
  declaredOmitted: BodyOmitted,
  declaredSize: number,
  bodies: BodyStore,
  perBodyBytes: number,
): BodyRef {
  if (bytes == null) {
    if (declaredOmitted == null) return { ...ABSENT };
    return { state: 'omitted', sha256: null, size: declaredSize, storedSize: 0, encoding: 'utf8', omitted: declaredOmitted };
  }
  const encoding = declaredOmitted === 'binary' ? 'binary' : 'utf8';
  const size = bytes.length;
  // A single body over the per-body cap is dropped for size before it can crowd
  // the shared budget; its metadata (the original size) is kept.
  if (size > perBodyBytes) {
    return { state: 'omitted', sha256: null, size, storedSize: 0, encoding, omitted: 'size' };
  }
  const sha256 = bodies.acquire(bytes);
  if (sha256 == null) {
    // Bodies budget full: drop the bytes with an explicit `budget` reason.
    return { state: 'omitted', sha256: null, size, storedSize: 0, encoding, omitted: 'budget' };
  }
  return { state: 'captured', sha256, size, storedSize: size, encoding, omitted: null };
}

export function releaseBodyRef(ref: BodyRef, bodies: BodyStore): void {
  if (ref.state === 'captured' && ref.sha256) bodies.release(ref.sha256);
}

// Materialize a BodyRef back into the legacy text DTO triple. Captured UTF-8 is
// decoded from the retained bytes; captured binary and every omission surface as
// a null body with the matching marker, exactly as the pre-T08 DTO did.
export function materializeBody(ref: BodyRef, bodies: BodyStore): { body: string | null; size: number; omitted: BodyOmitted } {
  if (ref.state === 'absent') return { body: null, size: 0, omitted: null };
  if (ref.state === 'omitted') return { body: null, size: ref.size ?? 0, omitted: ref.omitted };
  // captured
  if (ref.encoding === 'binary') return { body: null, size: ref.size ?? ref.storedSize, omitted: 'binary' };
  const bytes = ref.sha256 ? bodies.read(ref.sha256) : undefined;
  return { body: bytes ? Buffer.from(bytes).toString('utf8') : null, size: ref.size ?? ref.storedSize, omitted: null };
}

// Legacy `Entry` (text bodies) -> `EntryInput` (bytes). A present text body is
// encoded to UTF-8 bytes; an omitted or absent body carries no bytes but keeps
// its marker and declared size so the store can tell the two apart.
export function legacyEntryToInput(e: Entry): EntryInput {
  const toBytes = (text: string | null, omitted: BodyOmitted): Uint8Array | null =>
    text != null && omitted == null ? Buffer.from(text, 'utf8') : null;
  const { requestBody, responseBody, ...rest } = e;
  return { ...rest, requestBytes: toBytes(requestBody, e.requestBodyOmitted), responseBytes: toBytes(responseBody, e.responseBodyOmitted) };
}

// `StoredEntry` -> `EntrySummary` for a metadata page: identity + BodyRefs, no
// headers, no body bytes. The refs carry sha256/size/omission so the UI can key
// a formatting cache and fetch the bytes on demand from `/body`.
export function storedToEntrySummary(s: StoredEntry): EntrySummary {
  return {
    id: s.id, deviceId: s.deviceId, source: s.source, startedAt: s.startedAt,
    method: s.method, url: s.url, status: s.status, durationMs: s.durationMs, error: s.error,
    requestBody: s.requestBody, responseBody: s.responseBody,
  };
}

// `StoredEntry` -> `EntryDetail`: the summary plus headers and statusText, still
// with no body bytes materialized.
export function storedToEntryDetail(s: StoredEntry): EntryDetail {
  return {
    ...storedToEntrySummary(s),
    requestHeaders: s.requestHeaders, responseHeaders: s.responseHeaders, statusText: s.statusText,
  };
}

// A stored frame -> `FrameSummary`: metadata + BodyRef by stable sequence, no
// payload bytes.
export function storedFrameToSummary(fr: StoredFrame): FrameSummary {
  return { sequence: fr.sequence, ts: fr.ts, direction: fr.direction, binary: fr.binary, body: fr.body };
}

// `StoredEntry` -> legacy `Entry` DTO, reconstructing text bodies on demand.
export function storedToEntry(s: StoredEntry, bodies: BodyStore): Entry {
  const req = materializeBody(s.requestBody, bodies);
  const res = materializeBody(s.responseBody, bodies);
  const { requestBody, responseBody, ...rest } = s;
  return {
    ...rest,
    requestBody: req.body, requestBodySize: req.size, requestBodyOmitted: req.omitted,
    responseBody: res.body, responseBodySize: res.size, responseBodyOmitted: res.omitted,
  };
}
