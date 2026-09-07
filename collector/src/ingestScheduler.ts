import type { Budget } from './atlantis/frames.js';
import { log as defaultLog } from './log.js';

// Shared byte budget for framing buffers + queued frames. Admission pauses at 75%
// of the hard cap and resumes below 50% (hysteresis), so a device that briefly
// spikes is throttled, not flapped. Reserve fails past the hard cap; the caller
// closes just that connection with an `overload` counter rather than dropping bytes.
export class ByteBudget implements Budget {
  private usedBytes = 0;
  private pausedFlag = false;
  constructor(private readonly hard: number, private readonly pauseAt = 0.75, private readonly resumeAt = 0.5) {}
  reserve(n: number): boolean {
    if (this.usedBytes + n > this.hard) return false;
    this.usedBytes += n; this.recompute(); return true;
  }
  release(n: number): void { this.usedBytes = Math.max(0, this.usedBytes - n); this.recompute(); }
  used(): number { return this.usedBytes; }
  hardLimit(): number { return this.hard; }
  shouldPause(): boolean { return this.pausedFlag; }
  private recompute(): void {
    const r = this.usedBytes / this.hard;
    if (!this.pausedFlag && r >= this.pauseAt) this.pausedFlag = true;
    else if (this.pausedFlag && r < this.resumeAt) this.pausedFlag = false;
  }
}

export type WorkStats = {
  connections: number;
  queued: number;
  activeDecodes: number;
  applied: number;
  invalid: number;
  overload: number;
  closedForErrors: number;
  budgetUsed: number;
};

type QueueItem = { frame: Buffer; bytes: number };
type Conn = {
  id: string;
  queue: QueueItem[];
  decoding: boolean;
  closed: boolean;
  invalidTimes: number[];
  lastErrorLog: number;
  errorsByReason: Map<string, number>; // per-reason tally since the last throttled log
};

const MAX_PENDING_PER_CONN = 8;
const MAX_PENDING_GLOBAL = 64;
const DECODE_SLOTS_GLOBAL = 2;
const ERROR_LOG_INTERVAL_MS = 5_000;
const INVALID_WINDOW_MS = 10_000;
const INVALID_LIMIT = 10;

// A processor reports success, or failure WITH a reason so errors aggregate per
// reason (not one opaque `invalid` bucket). Throwing is treated as reason 'threw'.
export type ProcessOutcome = { ok: true } | { ok: false; reason: string };
export type FrameProcessor = (connId: string, frame: Buffer) => Promise<ProcessOutcome>;

export type SchedulerOpts = {
  budget: Budget;
  // Default decoder when a connection registers no handler. Decode buffers must be
  // released here (they are discarded on return).
  process?: FrameProcessor;
  // Fallback close hook (10 invalid in 10s) when a connection registered none of its
  // own via registerHandler's third argument. Kept for unit tests.
  onOverload?: (connId: string, reason: 'invalid') => void;
  log?: { warn: (...a: unknown[]) => void };
  now?: () => number;
};

// O01: bounded, fair ingest work. FIFO per connection preserves event order; a
// global round-robin plus a 2-slot decode budget keeps one noisy device from
// starving a quiet one. The event loop is handed back between frames.
export class IngestScheduler {
  private conns = new Map<string, Conn>();
  private handlers = new Map<string, FrameProcessor>();
  private closers = new Map<string, () => void>();
  private runnable: string[] = [];
  private activeDecodes = 0;
  private queued = 0;
  private applied = 0;
  private invalid = 0;
  private overload = 0;
  private closedForErrors = 0;
  private readonly budget: Budget;
  private readonly now: () => number;
  private readonly logw: { warn: (...a: unknown[]) => void };

  constructor(private readonly opts: SchedulerOpts) {
    this.budget = opts.budget;
    this.now = opts.now ?? Date.now;
    this.logw = opts.log ?? defaultLog;
  }

  private conn(id: string): Conn {
    let c = this.conns.get(id);
    if (!c) { c = { id, queue: [], decoding: false, closed: false, invalidTimes: [], lastErrorLog: 0, errorsByReason: new Map() }; this.conns.set(id, c); }
    return c;
  }

  // Register the per-connection frame processor (transport-specific: async Atlantis
  // decode vs. WSS JSON parse) and, optionally, the close hook the scheduler invokes
  // when it decides to drop the emitter (10 invalid in 10s) — that hook must actually
  // tear the transport socket down. Both cleared by close().
  registerHandler(connectionId: string, fn: FrameProcessor, onClose?: () => void): void {
    this.handlers.set(connectionId, fn);
    if (onClose) this.closers.set(connectionId, onClose);
    this.conn(connectionId);
  }

  // Enqueue an owned frame. Returns 'overload' when the per-connection (8) or global
  // (64) pending cap is hit; the caller then releases the frame's bytes and closes
  // the connection. On 'accepted' the scheduler owns the bytes and releases them
  // once the frame is processed.
  submit(connectionId: string, frame: Buffer): 'accepted' | 'overload' {
    const c = this.conn(connectionId);
    if (c.closed) { this.overload++; return 'overload'; }
    if (c.queue.length >= MAX_PENDING_PER_CONN || this.queued >= MAX_PENDING_GLOBAL) {
      this.overload++; return 'overload';
    }
    c.queue.push({ frame, bytes: frame.length });
    this.queued++;
    if (!c.decoding && !this.runnable.includes(connectionId)) this.runnable.push(connectionId);
    this.schedule();
    return 'accepted';
  }

  // Drop everything for a connection (disconnect / auth_error / shutdown): queued
  // frames release their reserved bytes and the connection is forgotten.
  close(connectionId: string): void {
    const c = this.conns.get(connectionId);
    if (!c) return;
    c.closed = true;
    for (const item of c.queue) this.budget.release(item.bytes);
    this.queued -= c.queue.length;
    c.queue = [];
    this.runnable = this.runnable.filter((id) => id !== connectionId);
    this.handlers.delete(connectionId);
    this.closers.delete(connectionId);
    if (!c.decoding) this.conns.delete(connectionId);
  }

  // Record an overload the transport handled itself (e.g. a connection closed for
  // parking too long above the budget line), so it shows in the counter.
  noteOverload(): void { this.overload++; }

  stats(): WorkStats {
    return {
      connections: this.conns.size,
      queued: this.queued,
      activeDecodes: this.activeDecodes,
      applied: this.applied,
      invalid: this.invalid,
      overload: this.overload,
      closedForErrors: this.closedForErrors,
      budgetUsed: (this.budget as ByteBudget).used?.() ?? 0,
    };
  }

  private schedule(): void {
    // Yield to the event loop between turns so a burst never monopolizes it.
    setImmediate(() => this.pump());
  }

  private pump(): void {
    while (this.activeDecodes < DECODE_SLOTS_GLOBAL && this.runnable.length > 0) {
      const id = this.runnable.shift()!;
      const c = this.conns.get(id);
      if (!c || c.closed || c.decoding || c.queue.length === 0) continue;
      const item = c.queue.shift()!;
      this.queued--;
      c.decoding = true;
      this.activeDecodes++;
      void this.run(c, item);
    }
  }

  private async run(c: Conn, item: QueueItem): Promise<void> {
    let outcome: ProcessOutcome = { ok: false, reason: 'threw' };
    const handler = this.handlers.get(c.id) ?? this.opts.process;
    try {
      outcome = handler ? await handler(c.id, item.frame) : { ok: false, reason: 'no_handler' };
    } catch {
      outcome = { ok: false, reason: 'threw' };
    } finally {
      this.budget.release(item.bytes);
      this.activeDecodes--;
      c.decoding = false;
    }
    if (outcome.ok) this.applied++;
    else this.recordInvalid(c, outcome.reason);

    if (c.closed) { if (c.queue.length === 0) this.conns.delete(c.id); }
    else if (c.queue.length > 0 && !this.runnable.includes(c.id)) this.runnable.push(c.id);
    this.schedule();
  }

  private recordInvalid(c: Conn, reason: string): void {
    this.invalid++;
    const t = this.now();
    c.invalidTimes.push(t);
    while (c.invalidTimes.length && t - c.invalidTimes[0] > INVALID_WINDOW_MS) c.invalidTimes.shift();
    c.errorsByReason.set(reason, (c.errorsByReason.get(reason) ?? 0) + 1);
    // Aggregate the log BY REASON, at most once per 5 s per connection.
    if (t - c.lastErrorLog >= ERROR_LOG_INTERVAL_MS) {
      const breakdown = [...c.errorsByReason].map(([r, n]) => `${r}=${n}`).join(' ');
      this.logw.warn('ingest: invalid frames', c.id, breakdown);
      c.lastErrorLog = t; c.errorsByReason.clear();
    }
    if (c.invalidTimes.length >= INVALID_LIMIT && !c.closed) {
      this.closedForErrors++;
      const closer = this.closers.get(c.id);
      if (closer) closer(); else this.opts.onOverload?.(c.id, 'invalid');
      this.close(c.id);
    }
  }
}
