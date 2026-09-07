// v2 authenticated ceiling; the historical 64 MiB survives only behind the opt-in
// legacy loopback fixture.
export const MAX_FRAME_V2 = 8 * 1024 * 1024;
export const LEGACY_MAX_FRAME = 64 * 1024 * 1024;
// Back-compat alias for callers that imported the pre-v2 name.
export const MAX_FRAME = LEGACY_MAX_FRAME;

// A shared byte budget (framing buffers + scheduler queue). `reserve` returns false
// when the hard cap would be exceeded, which the caller turns into a connection
// close with an `overload` counter — bytes are never dropped mid-stream instead.
export interface Budget {
  reserve(n: number): boolean;
  release(n: number): void;
}

export class OverloadError extends Error {
  constructor(msg: string) { super(msg); this.name = 'OverloadError'; }
}

// Length-prefixed (8-byte LE header) frame reassembler. A read cursor advances over
// a queue of chunks and consumed slots are nulled out and periodically compacted, so
// a large frame spread across many chunks stays O(n) rather than O(n²) and no
// unbounded array of frames is ever materialized for a burst — the caller pulls one
// frame at a time via takeFrame().
export class FrameAccumulator {
  private chunks: (Buffer | null)[] = [];
  private head = 0;   // index of the current (partially consumed) chunk
  private pos = 0;    // read offset within chunks[head]
  private avail = 0;  // live bytes from the cursor onward
  private expected: number | null = null; // payload length once the header is known
  private reservedConcat = 0;             // concat headroom reserved for `expected` (0 when none)
  private reservedInput = 0;              // input bytes reserved on this accumulator

  constructor(private maxFrame = MAX_FRAME_V2, private readonly budget?: Budget) {}

  // Tighten or loosen the frame ceiling in place. The Atlantis server runs pre-auth
  // under the 64 KiB ceiling (so a peer cannot make us reserve megabytes before it
  // proves a token) and raises it to the v2 8 MiB ceiling only once authenticated.
  setMaxFrame(n: number): void { this.maxFrame = n; }

  // Buffer a chunk. Its bytes are reserved against the shared budget; a chunk that
  // would breach the hard cap raises OverloadError so the owner closes just this
  // connection.
  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.budget && !this.budget.reserve(chunk.length)) {
      throw new OverloadError(`ingest budget exceeded by ${chunk.length}B chunk`);
    }
    this.reservedInput += chunk.length;
    this.chunks.push(chunk);
    this.avail += chunk.length;
  }

  // Payload length of the next frame once its 8-byte header has arrived, else null.
  // Learning the length reserves concat headroom for the eventual owned copy.
  expectedLength(): number | null {
    if (this.expected != null) return this.expected;
    if (this.avail < 8) return null;
    const len = this.peek(8).readBigUInt64LE(0);
    if (len > BigInt(this.maxFrame)) throw new OverloadError(`atlantis frame too large: ${len}`);
    const n = Number(len);
    // The ceiling is checked BEFORE any reservation, so an oversize declaration is
    // rejected without ever consuming budget (see CRITICAL 1: pre-auth exhaustion).
    this.expected = n;
    if (this.budget && this.reservedConcat === 0 && n > 0) {
      if (!this.budget.reserve(n)) throw new OverloadError(`ingest budget exceeded by ${n}B frame`);
      this.reservedConcat = n;
    }
    return n;
  }

  hasCompleteFrame(): boolean {
    const n = this.expectedLength();
    return n != null && this.avail >= 8 + n;
  }

  // Hand off the next complete frame, transferring ownership of its `n` reserved
  // bytes to the caller (which releases them when its job finishes). The 8-byte
  // header plus the raw input bytes for this frame are released here.
  takeFrame(): Buffer | null {
    if (!this.hasCompleteFrame()) return null;
    const n = this.expected!;
    this.consume(8);
    const frame = this.copy(n);
    this.consume(n);
    // Release the raw input reservation for header+payload; the concat `n` stays
    // reserved as the frame the caller now owns, so we zero our own tally of it
    // (transfer, not release) — dispose() must not double-release it.
    if (this.budget) this.budget.release(8 + n);
    this.reservedInput -= 8 + n;
    this.reservedConcat = 0;
    this.expected = null;
    return frame;
  }

  // Compatibility drain used by unit tests and the legacy loopback path: append and
  // return every currently-complete frame. Not budget-aware.
  push(chunk: Buffer): Buffer[] {
    this.append(chunk);
    const out: Buffer[] = [];
    for (let f = this.takeFrame(); f; f = this.takeFrame()) out.push(f);
    return out;
  }

  bufferedBytes(): number { return this.avail; }

  // Release ALL bytes still reserved (connection close / auth failure / shutdown):
  // buffered input AND any concat headroom reserved for an in-flight frame that was
  // never taken. Missing the concat half leaked the shared budget permanently on a
  // header-then-disconnect (CRITICAL 1).
  dispose(): void {
    if (this.budget) {
      const held = this.reservedInput + this.reservedConcat;
      if (held > 0) this.budget.release(held);
    }
    this.reservedInput = 0;
    this.reservedConcat = 0;
    this.chunks = [];
    this.head = this.pos = this.avail = 0;
    this.expected = null;
  }

  // Copy `count` bytes from the cursor without consuming them.
  private peek(count: number): Buffer {
    const first = this.chunks[this.head]!;
    if (first.length - this.pos >= count) return first.subarray(this.pos, this.pos + count);
    const out = Buffer.allocUnsafe(count);
    let filled = 0, i = this.head, off = this.pos;
    while (filled < count) {
      const c = this.chunks[i]!;
      const take = Math.min(count - filled, c.length - off);
      c.copy(out, filled, off, off + take);
      filled += take; off = 0; i++;
    }
    return out;
  }

  private copy(count: number): Buffer {
    const first = this.chunks[this.head];
    if (first && first.length - this.pos >= count) return Buffer.from(first.subarray(this.pos, this.pos + count));
    return this.peek(count);
  }

  private consume(count: number): void {
    this.avail -= count;
    let need = count;
    while (need > 0) {
      const c = this.chunks[this.head]!;
      const inChunk = c.length - this.pos;
      if (inChunk <= need) {
        this.chunks[this.head] = null; // drop the reference so the buffer can be GC'd
        this.head++; this.pos = 0; need -= inChunk;
      } else {
        this.pos += need; need = 0;
      }
    }
    // Amortized compaction: once the consumed prefix dominates, splice it away.
    if (this.head > 32 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }
}
