import { createHash } from 'node:crypto';

// Content-addressed, reference-counted body store (R6/O05). Captured request,
// response and WebSocket-frame bytes live here exactly once, keyed by the
// SHA-256 of their (already redacted) bytes, so identical payloads — including
// the same capture arriving from two devices — share one immutable blob while
// each reference is counted independently. A `clear` on one device releases its
// references but never frees a blob another device still holds.
//
// The store owns a private, immutable copy of every blob: `acquire` copies the
// caller's bytes with `.slice()` so a small body carved out of a large decode
// buffer never pins that big backing allocation, and a later mutation of the
// parser's buffer can never change what was hashed.
export interface BodyStore {
  // Retain `bytes`, returning the blob hash, or null when a NEW blob would push
  // the retained total past `maxBytes`. An already-present blob always succeeds
  // (it adds a reference, not bytes).
  acquire(bytes: Uint8Array): string | null;
  // Add one reference to an ALREADY-PRESENT blob by hash (no bytes, no budget
  // check): returns true when the blob exists and was retained, false otherwise.
  // Used by an export snapshot to pin the bodies it copied so a concurrent
  // clear/eviction cannot free them mid-stream, while still counting against the
  // budget (a new capture during export sees the bytes as retained).
  retain(hash: string): boolean;
  // Drop one reference to `hash`; the blob's bytes are freed at zero references.
  release(hash: string): void;
  // The immutable bytes for `hash`, or undefined once fully released.
  read(hash: string): Uint8Array | undefined;
  stats(): { retainedBytes: number; blobCount: number; references: number };
}

export type BodyStoreOptions = { maxBytes?: number };

// Bodies budget from the global constraints: 64 MiB retained across all blobs.
export const DEFAULT_BODY_BUDGET = 64 * 1024 * 1024;

type Blob = { bytes: Uint8Array; refs: number };

export function createBodyStore(opts: BodyStoreOptions = {}): BodyStore {
  const maxBytes = opts.maxBytes ?? DEFAULT_BODY_BUDGET;
  const blobs = new Map<string, Blob>();
  let retainedBytes = 0;
  let references = 0;

  const hashOf = (bytes: Uint8Array): string =>
    createHash('sha256').update(bytes).digest('hex');

  return {
    acquire(bytes: Uint8Array): string | null {
      const hash = hashOf(bytes);
      const existing = blobs.get(hash);
      if (existing) { existing.refs++; references++; return hash; }
      // A new blob must fit within the global budget before we copy it in.
      if (retainedBytes + bytes.length > maxBytes) return null;
      // Own an immutable copy detached from the caller's backing buffer.
      const owned = bytes.slice();
      blobs.set(hash, { bytes: owned, refs: 1 });
      retainedBytes += owned.length;
      references++;
      return hash;
    },
    retain(hash: string): boolean {
      const blob = blobs.get(hash);
      if (!blob) return false;
      blob.refs++;
      references++;
      return true;
    },
    release(hash: string): void {
      const blob = blobs.get(hash);
      if (!blob) return;
      blob.refs--;
      references--;
      if (blob.refs <= 0) { blobs.delete(hash); retainedBytes -= blob.bytes.length; }
    },
    read(hash: string): Uint8Array | undefined {
      return blobs.get(hash)?.bytes;
    },
    stats() { return { retainedBytes, blobCount: blobs.size, references }; },
  };
}
