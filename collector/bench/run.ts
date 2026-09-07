// Terminus synthetic load / resource baseline runner.
//
// Drives the REAL collector hot paths (Atlantis framing+gunzip+decode+redact+store,
// and the legacy own-protocol validate+store path) with deterministic synthetic
// fixtures on loopback only. It records *offered vs processed* work — never a
// throughput promise — plus event-loop delay, CPU, memory, queue peaks, retention
// and drop reasons. No bodies, headers or tokens are ever written to the output.
//
// Counters/limits are deterministic gates; times and RSS are separate measurements
// with real variability. See bench/README.md and the report contract.
import { performance, monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { Store, MAX_ENTRIES } from '../src/store.js';
import { FrameAccumulator } from '../src/atlantis/frames.js';
import { decodeAtlantis, V2_LIMITS } from '../src/atlantis/decode.js';
import { createHttpServer } from '../src/http.js';
import { createUiAuth } from '../src/security/uiAuth.js';
import { randomBytes } from 'node:crypto';
import { isDeviceMessage, type DeviceMessage } from '../src/types.js';
import * as fx from './fixtures.js';

// ---------------------------------------------------------------------------
// WorkStats contract (harness-side instrumentation; NOT a public SDK API).
// received includes items refused by overload/validation; pendingItems includes
// active jobs not yet applied; partial framing bytes count even without a full
// message. Invariant: received === applied + dropped + pendingItems.
// ---------------------------------------------------------------------------
export type WorkStats = {
  pendingBytes: number; pendingItems: number; activeJobs: number;
  received: number; applied: number; dropped: number;
};
type DropReason = 'overload' | 'undecodable' | 'bad_json' | 'invalid' | 'no_hello' | 'frame_too_large' | 'cancelled' | 'error';

const now = () => performance.now();

// Generic bounded pipeline: bytes/items are offered, held in a FIFO queue with a
// concurrency limit, then processed against a real collector component. Retained
// bytes (queue + active + un-framed) are tracked separately from in-flight items.
abstract class PipelineHarness<T> {
  received = 0; applied = 0; dropped = 0; activeJobs = 0;
  readonly dropReasons: Partial<Record<DropReason, number>> = {};
  peakItems = 0; peakBytes = 0; leftoverBytes = 0;
  readonly latencies: number[] = [];
  protected unframed = 0;               // bytes held before framing (accumulator)
  private q: { item: T; bytes: number; ts: number }[] = [];
  private queuedBytes = 0; private activeBytes = 0;
  private running = 0; private stopped = false;
  private waiters: (() => void)[] = [];

  constructor(readonly store: Store, private readonly maxInFlight: number, private readonly concurrency: number) {}

  protected abstract process(item: T): DropReason | null; // null = applied

  protected bump(r: DropReason): void { this.dropReasons[r] = (this.dropReasons[r] ?? 0) + 1; }

  // Offer one already-framed item. Applies the in-flight admission gate: excess is
  // an explicit overload drop (received++ then dropped++), not silent loss.
  protected offer(item: T, bytes: number): void {
    this.received++;
    if (this.stopped || this.q.length + this.activeJobs >= this.maxInFlight) { this.dropped++; this.bump('overload'); return; }
    this.q.push({ item, bytes, ts: now() });
    this.queuedBytes += bytes;
    this.observe();
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.q.length) {
      const job = this.q.shift()!;
      this.queuedBytes -= job.bytes; this.activeBytes += job.bytes;
      this.activeJobs++; this.running++;
      Promise.resolve().then(() => {
        let reason: DropReason | null;
        try { reason = this.process(job.item); } catch { reason = 'error'; }
        if (reason) { this.dropped++; this.bump(reason); } else { this.applied++; this.latencies.push(now() - job.ts); }
        this.activeBytes -= job.bytes; this.activeJobs--; this.running--;
        this.observe();
        this.pump();
        if (!this.q.length && !this.activeJobs) { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
      });
    }
  }

  private observe(): void {
    const s = this.stats();
    if (s.pendingItems > this.peakItems) this.peakItems = s.pendingItems;
    if (s.pendingBytes > this.peakBytes) this.peakBytes = s.pendingBytes;
  }

  stats(): WorkStats {
    return { pendingBytes: this.unframed + this.queuedBytes + this.activeBytes,
      pendingItems: this.q.length + this.activeJobs, activeJobs: this.activeJobs,
      received: this.received, applied: this.applied, dropped: this.dropped };
  }

  // Wait for all in-flight work to complete without closing input (reusable mid-run).
  async drain(): Promise<void> {
    while (this.q.length || this.activeJobs) await new Promise<void>((r) => this.waiters.push(r));
  }

  // Close input and let in-flight work complete. Any bytes still un-framed never
  // formed an item; they are discarded (recorded as leftoverBytes) so pendingBytes
  // returns to 0. Cancellation of pending items is the caller's separate concern.
  async stopAndDrain(): Promise<void> {
    this.stopped = true;
    await this.drain();
    this.leftoverBytes += this.unframed; this.unframed = 0;
  }

  // Cancel input: queued items are accounted as drops ('cancelled'); jobs already
  // active keep their reserve until they finish — cancellation never frees an
  // in-use job. Un-framed bytes are discarded. Invariant is preserved throughout.
  async cancelAndDrain(): Promise<void> {
    this.stopped = true;
    for (const j of this.q) { this.queuedBytes -= j.bytes; this.dropped++; this.bump('cancelled'); }
    this.q = [];
    await this.drain(); // in-flight jobs complete (reserve held until done)
    this.leftoverBytes += this.unframed; this.unframed = 0;
  }

  // Assert the WorkStats invariant at any instant.
  assertInvariant(): void {
    const s = this.stats();
    if (s.received !== s.applied + s.dropped + s.pendingItems)
      throw new Error(`WorkStats invariant broken: received=${s.received} applied=${s.applied} dropped=${s.dropped} pending=${s.pendingItems}`);
  }
}

// Real Atlantis hot path: 8-byte-LE reassembly -> gunzip -> JSON -> redact -> store.
export class AtlantisHarness extends PipelineHarness<Buffer> {
  private acc = new FrameAccumulator();
  private wsCreated = new Set<string>();
  constructor(store: Store, maxInFlight = 64, concurrency = 2) { super(store, maxInFlight, concurrency); }

  feed(chunk: Buffer): void {
    this.unframed += chunk.length;
    let frames: Buffer[];
    try { frames = this.acc.push(chunk); }
    catch { this.received++; this.dropped++; this.bump('frame_too_large'); this.acc = new FrameAccumulator(); this.leftoverBytes += this.unframed; this.unframed = 0; return; }
    for (const f of frames) { this.unframed -= 8 + f.length; this.offer(f, f.length); }
  }

  protected process(f: Buffer): DropReason | null {
    // Decode with the authenticated V2 limits and route entries through the byte
    // path `addEntryInput` — exactly what the real Atlantis server does
    // (src/atlantis/server.ts:44). `addEntry` is the legacy text path and would
    // drop the decoded request/response bytes, under-measuring body hashing.
    const ev = decodeAtlantis(f, V2_LIMITS);
    if (!ev) return 'undecodable';
    if (ev.kind === 'connection') {
      this.store.touchDevice({ deviceId: ev.deviceKey, platform: 'ios', appVersion: ev.appVersion ?? '', buildProfile: 'atlantis', dropped: 0, lastSeen: fx.BASE_MS });
    } else if (ev.kind === 'traffic') {
      this.store.addEntryInput(ev.entry);
      if (ev.isWebsocket && !this.wsCreated.has(ev.entry.id)) {
        this.wsCreated.add(ev.entry.id);
        this.store.addWsSession({ wsId: ev.entry.id, deviceId: ev.entry.deviceId, source: 'atlantis', url: ev.entry.url, openedAt: ev.entry.startedAt, frames: [], closedAt: null, closeCode: null, closeReason: '' });
      }
    } else {
      if (!this.wsCreated.has(ev.trafficId)) {
        this.wsCreated.add(ev.trafficId);
        this.store.addWsSession({ wsId: ev.trafficId, deviceId: ev.deviceKey, source: 'atlantis', url: ev.url, openedAt: Math.round(ev.msg.createdAt * 1000), frames: [], closedAt: null, closeCode: null, closeReason: '' });
      }
      const dataValue = ev.msg.dataValue;
      const size = dataValue != null ? Buffer.from(dataValue, 'base64').length : Buffer.byteLength(ev.msg.stringValue ?? '');
      this.store.appendWsFrame(ev.trafficId, { ts: Math.round(ev.msg.createdAt * 1000), direction: ev.msg.messageType.startsWith('receive') ? 'in' : 'out', data: ev.msg.stringValue, size, binary: dataValue != null });
    }
    return null;
  }
}

// Legacy own-protocol local cost: JSON.parse -> validate -> applyDeviceMessage.
// One harness per device (mirrors one /ingest socket per device).
export class IngestHarness extends PipelineHarness<string> {
  private device: string | null = null;
  constructor(store: Store, maxInFlight = 64, concurrency = 2) { super(store, maxInFlight, concurrency); }
  feed(json: string): void { this.offer(json, Buffer.byteLength(json)); }
  protected process(json: string): DropReason | null {
    let msg: unknown;
    try { msg = JSON.parse(json); } catch { return 'bad_json'; }
    if (!isDeviceMessage(msg)) return 'invalid';
    if (msg.type === 'hello') this.device = msg.deviceId;
    if (!this.device) return 'no_hello';
    this.store.applyDeviceMessage(this.device, msg);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resource sampling around a measured window.
// ---------------------------------------------------------------------------
type MemSample = { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number };
class ResourceProbe {
  private h: IntervalHistogram; private cpu0!: NodeJS.CpuUsage; private t0 = 0;
  private peak: MemSample = zeroMem(); private base: MemSample = zeroMem(); private timer?: NodeJS.Timeout;
  constructor() { this.h = monitorEventLoopDelay({ resolution: 10 }); }
  start(): void {
    // Best-effort GC floor (needs --expose-gc) so the memory baseline reflects live
    // objects, not high-water from earlier scenarios in this shared process.
    (globalThis as { gc?: () => void }).gc?.();
    this.h.reset(); this.h.enable(); this.cpu0 = process.cpuUsage(); this.t0 = now();
    this.base = mem(); this.peak = { ...this.base };
    this.timer = setInterval(() => this.sample(), 250); this.timer.unref?.();
  }
  private sample(): void { const m = mem(); for (const k of Object.keys(m) as (keyof MemSample)[]) this.peak[k] = Math.max(this.peak[k], m[k]); }
  stop() {
    this.h.disable(); if (this.timer) clearInterval(this.timer); this.sample();
    const cpu = process.cpuUsage(this.cpu0); const wallMs = now() - this.t0;
    return {
      wallMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
      cpuPct: ((cpu.user + cpu.system) / 1000) / wallMs * 100,
      loopDelayMeanMs: this.h.mean / 1e6, loopDelayP99Ms: this.h.percentile(99) / 1e6, loopDelayMaxMs: this.h.max / 1e6,
      mem: this.peak, base: this.base, gcAvailable: typeof (globalThis as { gc?: () => void }).gc === 'function',
    };
  }
}
const mem = (): MemSample => { const m = process.memoryUsage(); return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers }; };
const zeroMem = (): MemSample => ({ rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 });
function pct(xs: number[], p: number): number { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retained work in a store (distinct from in-transit work in a harness).
function retention(store: Store) {
  const entries = store.entries(); const ws = store.wsSessions();
  let bodyBytes = 0, wsFrames = 0;
  for (const e of entries) bodyBytes += e.requestBodySize + e.responseBodySize;
  for (const w of ws) wsFrames += w.frames.length;
  return { entries: entries.length, wsSessions: ws.length, wsFrames, retainedBodyBytes: bodyBytes, atMax: store.atMax() };
}

function harnessReport(name: string, h: PipelineHarness<unknown>, probe: ReturnType<ResourceProbe['stop']>) {
  const s = h.stats();
  return {
    name, stats: s, dropReasons: h.dropReasons,
    peakPendingItems: h.peakItems, peakPendingBytes: h.peakBytes, leftoverBytes: h.leftoverBytes,
    latencyMs: { p50: round(pct(h.latencies, 50)), p95: round(pct(h.latencies, 95)), n: h.latencies.length },
    resource: probeOut(probe),
  };
}
const round = (n: number) => Math.round(n * 1000) / 1000;
const d0 = (n: number) => Math.max(0, n);
function probeOut(p: ReturnType<ResourceProbe['stop']>) {
  return { wallMs: round(p.wallMs), cpuUserMs: round(p.cpuUserMs), cpuSystemMs: round(p.cpuSystemMs), cpuPct: round(p.cpuPct),
    loopDelayMeanMs: round(p.loopDelayMeanMs), loopDelayP99Ms: round(p.loopDelayP99Ms), loopDelayMaxMs: round(p.loopDelayMaxMs),
    gcAvailable: p.gcAvailable,
    // Process-wide high-water marks (NOT attributable to this scenario alone).
    peakRssBytes: p.mem.rss, peakHeapUsedBytes: p.mem.heapUsed, peakHeapTotalBytes: p.mem.heapTotal,
    peakExternalBytes: p.mem.external, peakArrayBuffersBytes: p.mem.arrayBuffers,
    // Within-scenario deltas (peak minus the GC'd baseline at window start) — the
    // attributable per-scenario memory cost.
    heapUsedDeltaBytes: d0(p.mem.heapUsed - p.base.heapUsed), externalDeltaBytes: d0(p.mem.external - p.base.external),
    arrayBuffersDeltaBytes: d0(p.mem.arrayBuffers - p.base.arrayBuffers), rssDeltaBytes: d0(p.mem.rss - p.base.rss) };
}

// ---------------------------------------------------------------------------
// Scenarios. Each returns a JSON-safe result object (no bodies/headers/tokens).
// ---------------------------------------------------------------------------
type Cfg = { warmupSec: number; measureSec: number; reps: number; quick: boolean };

// Steady offered load: `rate` events/s/device for `deviceCount` devices, warmup + N reps.
async function steadyScenario(name: string, deviceCount: number, rate: number, cfg: Cfg) {
  const reps: unknown[] = [];
  let seq = 0;
  const store = new Store();
  const har = new AtlantisHarness(store);
  const devices = Array.from({ length: deviceCount }, (_, i) => fx.deviceId(i));
  for (const d of devices) har.feed(fx.atlantisFrame(fx.atlantisConnection(d)));

  // Pace the offered load in 20 ms slices so events are spread over time (as they
  // arrive on the wire), not dumped a full second at once. A well-provisioned
  // pipeline keeps up and drops ~0; genuine overflow is the separate burst scenario.
  const sliceMs = 20;
  const perSlice = Math.max(1, Math.round((deviceCount * rate * sliceMs) / 1000));
  // Generation (frame build + gzip) and processing share one sleep(sliceMs) loop, so
  // the *achieved* offered rate is below the nominal target; both are reported.
  const runWindow = async (durationSec: number, measure: boolean) => {
    const probe = new ResourceProbe(); if (measure) probe.start();
    const start = now(); const endAt = start + durationSec * 1000; let events = 0;
    while (now() < endAt) {
      for (let i = 0; i < perSlice; i++) {
        const dev = devices[seq % deviceCount];
        for (const env of fx.toAtlantisEnvelopes(fx.makeEvent(dev, seq), seq)) har.feed(fx.atlantisFrame(env));
        seq++; events++;
      }
      har.assertInvariant();
      await sleep(sliceMs);
    }
    return { probe: measure ? probe.stop() : null, events };
  };

  await runWindow(cfg.warmupSec, false);
  for (let r = 0; r < cfg.reps; r++) {
    // Per-rep deltas: the harness/store persist across reps, so snapshot counters and
    // latency index at the rep boundary and reset per-rep queue peaks. Reps are then
    // directly comparable instead of cumulative.
    const base = { received: har.received, applied: har.applied, dropped: har.dropped };
    const latBase = har.latencies.length; har.peakItems = 0; har.peakBytes = 0;
    const { probe, events } = await runWindow(cfg.measureSec, true);
    const lat = har.latencies.slice(latBase);
    const wallSec = probe!.wallMs / 1000;
    reps.push({ rep: r,
      delta: { received: har.received - base.received, applied: har.applied - base.applied, dropped: har.dropped - base.dropped },
      offeredEvents: events, wallSec: round(wallSec),
      achievedEventsPerSecPerDevice: round(events / wallSec / deviceCount),
      achievedFramesPerSec: round((har.received - base.received) / wallSec),
      latencyMs: { p50: round(pct(lat, 50)), p95: round(pct(lat, 95)), n: lat.length },
      peakPendingItems: har.peakItems, peakPendingBytes: har.peakBytes,
      resource: probeOut(probe!) });
  }
  await har.stopAndDrain();
  const post = har.stats();
  return { scenario: name, kind: 'steady', deviceCount, nominalRatePerDevice: rate,
    warmupSec: cfg.warmupSec, measureSec: cfg.measureSec, reps: reps.length,
    finalStats: post, drainedClean: post.pendingBytes === 0 && post.activeJobs === 0,
    retention: retention(store), repetitions: reps };
}

// Burst well above capacity: queue-full is an explicit drop scenario, not throughput.
async function burstScenario(deviceCount: number, rate: number, durationSec: number, cfg: Cfg) {
  const store = new Store();
  const har = new AtlantisHarness(store, 64, 2);
  const devices = Array.from({ length: deviceCount }, (_, i) => fx.deviceId(i));
  for (const d of devices) har.feed(fx.atlantisFrame(fx.atlantisConnection(d)));
  const probe = new ResourceProbe(); probe.start();
  // Coarse 100 ms spikes: a full 0.1 s of offered load lands in one synchronous read,
  // exceeding the 64-deep in-flight buffer, so overflow is dropped explicitly (with a
  // reason) and the pipeline recovers on the next slice. This exercises the drop
  // mechanism, NOT a throughput promise.
  const sliceMs = 100; const perSlice = Math.round((deviceCount * rate * sliceMs) / 1000);
  let seq = 0; let events = 0; const start = now();
  while (now() < start + durationSec * 1000) {
    for (let i = 0; i < perSlice; i++) {
      const dev = devices[seq % deviceCount];
      for (const env of fx.toAtlantisEnvelopes(fx.makeEvent(dev, seq), seq)) har.feed(fx.atlantisFrame(env));
      seq++; events++;
    }
    har.assertInvariant();
    await sleep(sliceMs);
  }
  const p = probe.stop();
  await har.stopAndDrain();
  const post = har.stats();
  const wallSec = p.wallMs / 1000;
  return { scenario: 'burst', kind: 'burst', deviceCount, nominalRatePerDevice: rate, durationSec,
    offeredEvents: events, achievedOfferedEventsPerSec: round(events / wallSec),
    achievedAppliedPerSec: round(post.applied / wallSec),
    ...harnessReport('burst', har as never, p), finalStats: post,
    drainedClean: post.pendingBytes === 0 && post.activeJobs === 0, retention: retention(store) };
}

// Fragmented framing: the same frames delivered in 1 B / 64 B / 16 KiB chunks.
async function framingScenario() {
  const results: unknown[] = [];
  const chunkSizes = [1, 64, 16 * 1024];
  const device = fx.deviceId(0);
  // Small frames on purpose: framing tests reassembly across chunk boundaries, not
  // volume. 1-byte chunking over MiB-scale bodies would be O(10M) ops.
  const frames = [fx.atlantisFrame(fx.atlantisConnection(device)),
    ...Array.from({ length: 40 }, (_, i) => fx.toAtlantisEnvelopes(fx.makeEvent(device, i, { kind: 'http', bodyBias: i % 2 }), i).map((e) => fx.atlantisFrame(e))).flat()];
  const wire = Buffer.concat(frames);
  for (const cs of chunkSizes) {
    const store = new Store(); const har = new AtlantisHarness(store);
    const probe = new ResourceProbe(); probe.start();
    let midPending = 0;
    for (let off = 0; off < wire.length; off += cs) {
      har.feed(wire.subarray(off, Math.min(off + cs, wire.length)));
      har.assertInvariant();
      midPending = Math.max(midPending, har.stats().pendingBytes);
    }
    const p = probe.stop();
    await har.stopAndDrain();
    const post = har.stats();
    results.push({ chunkBytes: cs, peakUnframedPlusQueuedBytes: midPending, ...harnessReport(`framing-${cs}`, har as never, p),
      finalStats: post, drainedClean: post.pendingBytes === 0 && post.activeJobs === 0, retention: retention(store) });
  }
  // Partial-frame variant: withhold the last 5 bytes, prove pendingBytes>0 then clean drain.
  const store = new Store(); const har = new AtlantisHarness(store);
  har.feed(wire.subarray(0, wire.length - 5));
  const partialPending = har.stats().pendingBytes; har.assertInvariant();
  await har.stopAndDrain();
  const post = har.stats();
  results.push({ chunkBytes: 'partial-truncated', withheldBytes: 5, pendingBytesBeforeDrain: partialPending,
    leftoverBytes: har.leftoverBytes, finalStats: post, drainedClean: post.pendingBytes === 0 });
  return { scenario: 'framing', kind: 'framing', variants: results };
}

// Expansive gzip: tiny frame payloads that gunzip to large bodies (CPU on decode).
async function gzipScenario(count: number, resSize: number) {
  const store = new Store(); const har = new AtlantisHarness(store);
  const device = fx.deviceId(0); har.feed(fx.atlantisFrame(fx.atlantisConnection(device)));
  const probe = new ResourceProbe(); probe.start();
  let wireBytes = 0;
  // Yield with a real macrotask (setImmediate), not a microtask: the event-loop-delay
  // histogram only samples across timer/immediate turns, so `await Promise.resolve()`
  // would leave the synchronous gunzip cost invisible (0.001 ms beside 125% CPU).
  for (let i = 0; i < count; i++) {
    const f = fx.atlantisExpansiveFrame(device, i, resSize); wireBytes += f.length; har.feed(f); har.assertInvariant();
    await new Promise<void>((r) => setImmediate(r));
  }
  const p = probe.stop();
  await har.stopAndDrain();
  const post = har.stats();
  return { scenario: 'gzip-expansive', kind: 'gzip', count, decompressedBodyBytes: resSize, totalWireBytes: wireBytes,
    ...harnessReport('gzip', har as never, p), finalStats: post, retention: retention(store) };
}

// Mixed rates: one noisy device + one low-rate device sharing the pipeline.
async function mixedRateScenario(durationSec: number) {
  const store = new Store(); const har = new AtlantisHarness(store);
  const noisy = fx.deviceId(0), quiet = fx.deviceId(1);
  har.feed(fx.atlantisFrame(fx.atlantisConnection(noisy))); har.feed(fx.atlantisFrame(fx.atlantisConnection(quiet)));
  const probe = new ResourceProbe(); probe.start();
  // 20 ms slices: noisy device ~500 ev/s, quiet device ~5 ev/s, sharing one FIFO
  // pipeline. Measures whether the quiet device's entries still land under a noisy
  // neighbour (fairness of a single shared queue).
  let seq = 0; const start = now(); let ticks = 0; let noisyEv = 0; let quietEv = 0;
  while (now() < start + durationSec * 1000) {
    for (let i = 0; i < 10; i++) { for (const env of fx.toAtlantisEnvelopes(fx.makeEvent(noisy, seq), seq)) har.feed(fx.atlantisFrame(env)); seq++; noisyEv++; } // noisy nominal ~500/s
    if (ticks % 10 === 0) { for (const env of fx.toAtlantisEnvelopes(fx.makeEvent(quiet, seq), seq)) har.feed(fx.atlantisFrame(env)); seq++; quietEv++; } // quiet nominal ~5/s
    har.assertInvariant(); ticks++; await sleep(20);
  }
  const p = probe.stop();
  await har.stopAndDrain();
  const wallSec = p.wallMs / 1000;
  return { scenario: 'mixed-rate', kind: 'mixed', durationSec, ...harnessReport('mixed-rate', har as never, p),
    finalStats: har.stats(), retention: retention(store),
    nominalRates: { noisyPerSec: 500, quietPerSec: 5 },
    achievedOfferedPerSec: { noisy: round(noisyEv / wallSec), quiet: round(quietEv / wallSec) },
    perDevice: { noisy: store.entries(noisy).length, quiet: store.entries(quiet).length } };
}

// Long WS session: one session, many frames appended over time.
async function wsLongScenario(durationSec: number) {
  const store = new Store(); const har = new AtlantisHarness(store);
  const device = fx.deviceId(0); har.feed(fx.atlantisFrame(fx.atlantisConnection(device)));
  const wsId = `${device}-ws-long`;
  har.feed(fx.atlantisFrame({ id: device, messageType: 'traffic', content: Buffer.from(JSON.stringify({ id: wsId, startAt: fx.BASE_MS / 1000, packageType: 'websocket', request: { url: 'wss://bench.invalid/long', method: 'GET', headers: [] }, response: null, responseBodyData: null, error: null })).toString('base64'), buildVersion: 'x' }));
  const probe = new ResourceProbe(); probe.start();
  let n = 0; const start = now();
  while (now() < start + durationSec * 1000) {
    const inner = { id: wsId, startAt: fx.BASE_MS / 1000, packageType: 'websocket', request: { url: 'wss://bench.invalid/long', method: 'GET', headers: [] },
      websocketMessagePackage: { id: `${wsId}-m${n}`, createdAt: fx.BASE_MS / 1000 + n * 0.001, messageType: n % 2 ? 'sendMessage' : 'receiveMessage', stringValue: `frame ${n}`, dataValue: null } };
    har.feed(fx.atlantisFrame({ id: device, messageType: 'websocket', content: Buffer.from(JSON.stringify(inner)).toString('base64'), buildVersion: 'x' }));
    n++; har.assertInvariant(); await sleep(5);
  }
  const p = probe.stop();
  await har.stopAndDrain();
  const ws = store.wsSessions(device)[0];
  return { scenario: 'ws-long', kind: 'ws', durationSec, framesAppended: ws?.frames.length ?? 0,
    ...harnessReport('ws-long', har as never, p), finalStats: har.stats(), retention: retention(store) };
}

// Clear then new events: retention released, pipeline keeps counting.
async function clearChurnScenario(rounds: number, perRound: number) {
  const store = new Store(); const har = new AtlantisHarness(store);
  const device = fx.deviceId(0); har.feed(fx.atlantisFrame(fx.atlantisConnection(device)));
  const probe = new ResourceProbe(); probe.start();
  let seq = 0; const retentionAfterClear: number[] = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < perRound; i++) {
      for (const env of fx.toAtlantisEnvelopes(fx.makeEvent(device, seq, { kind: 'http' }), seq)) har.feed(fx.atlantisFrame(env));
      seq++;
      if (i % 16 === 0) await sleep(0); // let the pipeline drain so we test retention, not the buffer cap
    }
    await har.drain();                 // let the round's events land (input stays open)
    store.clear();                      // clear seguido de novos eventos
    retentionAfterClear.push(retention(store).entries);
    har.assertInvariant();
  }
  const p = probe.stop();
  await har.stopAndDrain();
  return { scenario: 'clear-churn', kind: 'clear', rounds, perRound, entriesAfterEachClear: retentionAfterClear,
    ...harnessReport('clear-churn', har as never, p), finalStats: har.stats(), retention: retention(store) };
}

// Start a real loopback collector HTTP server with UI auth wired, and exchange the
// admin bearer for an nc_session cookie. /ui, /api/* and /export.* are all
// session-gated now (T01/T02/T10), so the bench authenticates exactly as the UI does.
async function startAuthedServer(store: Store) {
  const uiDir = path.dirname(fileURLToPath(import.meta.url)); // any real dir; sockets/exports only
  const adminToken = randomBytes(32).toString('base64url');
  const uiAuth = createUiAuth({ adminToken });
  const app = createHttpServer(store, uiDir, { uiAuth });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const port = (app.server.address() as import('net').AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const sessRes = await fetch(`${origin}/api/session`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}`, origin } });
  const setCookie = sessRes.headers.get('set-cookie');
  if (!setCookie) throw new Error(`bench: no session cookie (status ${sessRes.status})`);
  const cookie = setCookie.split(';')[0];
  return { app, port, origin, cookie };
}

// UI fan-out on a real loopback server: a reading client vs a client that stops
// reading. Before the O06/O07 caps the server buffered unbounded bytes for the
// stalled reader; with the caps in place the server closes it and keeps the
// healthy client streaming.
async function uiScenario(events: number) {
  const store = new Store();
  const { app, port, origin, cookie } = await startAuthedServer(store);

  let goodMsgs = 0, goodBytes = 0;
  const good = new WebSocket(`ws://127.0.0.1:${port}/ui`, { headers: { cookie, origin } });
  good.on('message', (d: Buffer) => { goodMsgs++; goodBytes += d.length; });
  const slow = new WebSocket(`ws://127.0.0.1:${port}/ui`, { headers: { cookie, origin } });
  await Promise.all([once(good, 'open'), once(slow, 'open')]);
  // Make `slow` stop reading: pause its underlying socket so server buffers back up.
  (slow as unknown as { _socket: import('net').Socket })._socket.pause();

  const device = fx.deviceId(0);
  store.applyDeviceMessage(device, fx.helloMessage(device));
  for (let i = 0; i < events; i++) {
    const e = fx.makeEvent(device, i, { kind: 'http' });
    for (const m of fx.toDeviceMessages(e, i)) store.applyDeviceMessage(device, m as DeviceMessage);
  }
  await sleep(500); // let the reading client drain

  let slowBuffered = 0;
  for (const c of app.wss.clients) slowBuffered = Math.max(slowBuffered, (c as WebSocket).bufferedAmount);
  // With the O06/O07 caps live the stalled reader is closed by the server rather than
  // buffered without bound; record whether that happened and the healthy client's flow.
  const slowClosed = slow.readyState === WebSocket.CLOSING || slow.readyState === WebSocket.CLOSED;
  // State publications = the update messages the server actually pushed to a reading
  // client (1 snapshot + one delta per store emit — an HTTP event emits two: addEntry
  // then updateEntry). Counted from real messages received, not store size.
  const publications = goodMsgs;

  good.close(); slow.terminate(); app.close();
  return { scenario: 'ui-fanout', kind: 'ui', offeredEvents: events, statePublications: publications,
    readingClient: { messages: goodMsgs, bytes: goodBytes },
    nonReadingClientPeakBufferedBytes: slowBuffered, nonReadingClientClosedByServer: slowClosed,
    note: 'With the O06/O07 fan-out caps (8 MiB/socket, 32 MiB global) a reader that stops draining is closed by the server, not buffered without bound; the healthy client keeps streaming. Row-node mount count and time-to-visible-update remain browser-side (covered by the Playwright UI suite).' };
}

// Export lease: HAR export requested then cancelled mid-stream on loopback.
async function exportScenario(entries: number) {
  const store = new Store();
  const { app, port, origin, cookie } = await startAuthedServer(store);
  const device = fx.deviceId(0); store.applyDeviceMessage(device, fx.helloMessage(device));
  for (let i = 0; i < entries; i++) { const e = fx.makeEvent(device, i, { kind: 'http', bodyBias: 2 }); for (const m of fx.toDeviceMessages(e, i)) store.applyDeviceMessage(device, m as DeviceMessage); }

  const t0 = now();
  const { received, cancelled, ttfbMs } = await new Promise<{ received: number; cancelled: boolean; ttfbMs: number }>((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/export.har', headers: { cookie, origin } }, (res) => {
      let got = 0; let first = -1;
      res.on('data', (c: Buffer) => { if (first < 0) first = now() - t0; got += c.length; if (got > 256 * 1024) { req.destroy(); resolve({ received: got, cancelled: true, ttfbMs: first }); } });
      res.on('end', () => resolve({ received: got, cancelled: false, ttfbMs: first }));
    });
    req.on('error', () => { /* destroy fires error */ });
  });
  await sleep(50);
  const stillUp = app.server.listening;
  app.close();

  // Harness-side cancellation semantics: fill the queue, cancel, and confirm queued
  // items are accounted as drops while the invariant holds and the pipeline drains clean.
  const cstore = new Store(); const char = new AtlantisHarness(cstore, 64, 2);
  char.feed(fx.atlantisFrame(fx.atlantisConnection(device)));
  for (let i = 0; i < 200; i++) for (const env of fx.toAtlantisEnvelopes(fx.makeEvent(device, i, { kind: 'http', bodyBias: 0 }), i)) char.feed(fx.atlantisFrame(env));
  const pendingBeforeCancel = char.stats().pendingItems; char.assertInvariant();
  await char.cancelAndDrain();
  const cpost = char.stats();

  return { scenario: 'export-cancel', kind: 'export', entries, exportBytesBeforeCancel: received, cancelled,
    timeToFirstByteMs: round(ttfbMs), serverStillListeningAfterCancel: stillUp,
    harnessCancel: { pendingBeforeCancel, cancelledDrops: char.dropReasons.cancelled ?? 0,
      finalStats: cpost, drainedClean: cpost.pendingBytes === 0 && cpost.activeJobs === 0 },
    note: 'Export now streams under a body lease with a 30 s cap (T10). A cancelled export leaves retained entries untouched and releases the lease on abort; harness cancellation accounts queued items as drops without freeing in-use jobs.' };
}

// Legacy own-protocol local cost on the same steady fixture (transport-agnostic;
// TLS/auth v2 cost is NOT included here and is called out explicitly).
async function legacyScenario(deviceCount: number, rate: number, measureSec: number) {
  const store = new Store();
  const devices = Array.from({ length: deviceCount }, (_, i) => fx.deviceId(i));
  const hars = devices.map((d) => { const h = new IngestHarness(store); h.feed(JSON.stringify(fx.helloMessage(d))); return h; });
  const probe = new ResourceProbe(); probe.start();
  const sliceMs = 20; const perSlice = Math.max(1, Math.round((deviceCount * rate * sliceMs) / 1000));
  let seq = 0; let events = 0; const start = now();
  while (now() < start + measureSec * 1000) {
    for (let i = 0; i < perSlice; i++) {
      const di = seq % deviceCount;
      for (const m of fx.toDeviceMessages(fx.makeEvent(devices[di], seq), seq)) hars[di].feed(JSON.stringify(m));
      seq++; events++;
    }
    for (const h of hars) h.assertInvariant();
    await sleep(sliceMs);
  }
  const p = probe.stop();
  for (const h of hars) await h.stopAndDrain();
  const agg: WorkStats = { pendingBytes: 0, pendingItems: 0, activeJobs: 0, received: 0, applied: 0, dropped: 0 };
  for (const h of hars) { const s = h.stats(); agg.received += s.received; agg.applied += s.applied; agg.dropped += s.dropped; agg.pendingBytes += s.pendingBytes; }
  const lat = hars.flatMap((h) => h.latencies);
  const wallSec = p.wallMs / 1000;
  return { scenario: 'legacy-own-protocol', kind: 'legacy', deviceCount, nominalRatePerDevice: rate, measureSec,
    offeredEvents: events, achievedEventsPerSecPerDevice: round(events / wallSec / deviceCount),
    finalStats: agg, latencyMs: { p50: round(pct(lat, 50)), p95: round(pct(lat, 95)), n: lat.length },
    resource: probeOut(p), retention: retention(store),
    note: 'Local hot-path cost of the legacy WSS own-protocol only (JSON.parse + validate + store). It does NOT include TLS or auth-v2 handshake cost; this is not an end-to-end transport comparison.' };
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------
function once(ee: WebSocket, ev: string): Promise<void> { return new Promise((r) => ee.once(ev, () => r())); }

function env() {
  let sha = 'unknown';
  try { sha = execSync('git rev-parse HEAD', { cwd: path.dirname(fileURLToPath(import.meta.url)) }).toString().trim(); } catch { /* ignore */ }
  const cpu = os.cpus()[0];
  return { collectorSha: sha, node: process.version, os: `${os.type()} ${os.release()}`, arch: os.arch(),
    cpuModel: cpu?.model ?? 'unknown', cpuCount: os.cpus().length, totalMemBytes: os.totalmem(), maxEntriesPerDevice: MAX_ENTRIES };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const quick = args.includes('--quick');
  const scenario = opt('scenario', 'all')!;
  const output = opt('output');
  const report = opt('report');

  // Defaults encode the spec: 30 s warmup + 180 s measured window + 3 reps.
  const cfg: Cfg = quick
    ? { warmupSec: 2, measureSec: 4, reps: 1, quick: true }
    : { warmupSec: 30, measureSec: 180, reps: 3, quick: false };
  const num = (k: string) => { const v = opt(k); return v === undefined ? undefined : Number(v); };
  cfg.warmupSec = num('warmup') ?? cfg.warmupSec;
  cfg.measureSec = num('measure') ?? cfg.measureSec;
  cfg.reps = num('reps') ?? cfg.reps;
  const dur = (full: number, q: number) => (quick ? q : full);

  const want = (n: string) => scenario === 'all' || scenario === n;
  const started = new Date().toISOString();
  const results: Record<string, unknown> = {};

  if (want('steady')) {
    results.steady1 = await steadyScenario('steady-1dev', 1, 50, cfg);
    results.steady4 = await steadyScenario('steady-4dev', 4, 50, cfg);
  }
  if (want('burst')) results.burst = await burstScenario(1, 1000, dur(10, 3), cfg);
  if (want('framing')) results.framing = await framingScenario();
  if (want('gzip')) results.gzip = await gzipScenario(quick ? 15 : 100, 1024 * 1024);
  if (want('mixed')) results.mixed = await mixedRateScenario(dur(15, 4));
  if (want('ws')) results.wsLong = await wsLongScenario(dur(15, 4));
  if (want('clear')) results.clear = await clearChurnScenario(quick ? 3 : 10, quick ? 50 : 300);
  if (want('ui')) results.ui = await uiScenario(quick ? 200 : 2000);
  if (want('export')) results.export = await exportScenario(quick ? 100 : 500);
  if (want('legacy')) results.legacy = await legacyScenario(1, 50, dur(30, 4));

  const doc = { schema: 'terminus-baseline/1', startedAt: started, finishedAt: new Date().toISOString(),
    quick, scenarioSelector: scenario, env: env(), config: cfg, results };

  if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(doc, null, 2)); process.stdout.write(`wrote ${output}\n`); }
  if (report) { fs.mkdirSync(path.dirname(report), { recursive: true }); fs.writeFileSync(report, renderReport(doc)); process.stdout.write(`wrote ${report}\n`); }
  if (!output && !report) process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  process.stdout.write(summarise(doc) + '\n');
}

// Compact console summary (aggregates only, never bodies).
function summarise(doc: Record<string, unknown>): string {
  const r = doc.results as Record<string, any>;
  const lines: string[] = ['--- bench summary (offered vs processed; no throughput promise) ---'];
  for (const key of Object.keys(r)) {
    const s = r[key];
    const fs0 = s.finalStats ?? s.repetitions?.[s.repetitions.length - 1]?.stats;
    if (fs0) lines.push(`${s.scenario}: recv=${fs0.received} applied=${fs0.applied} dropped=${fs0.dropped} pendItems=${fs0.pendingItems} pendBytes=${fs0.pendingBytes}`);
  }
  return lines.join('\n');
}

const mib = (b: number) => (b / 1048576).toFixed(2);
function renderReport(doc: any): string {
  const e = doc.env; const c = doc.config; const r = doc.results;
  const L: string[] = [];
  L.push('# Terminus — synthetic load & resource baseline');
  L.push('');
  L.push('> Baseline of the collector hot paths **before** the T01–T13 hardening/optimisation fixes.');
  L.push('> All figures come from deterministic synthetic fixtures on loopback (`bench.invalid` hosts,');
  L.push('> fake `Bearer bench-…` tokens for the redactor only). No real capture data, bodies or tokens');
  L.push('> appear here. Counters and limits are deterministic gates; wall time, CPU and RSS are separate');
  L.push('> measurements with real variability and include runtime/parsing/gzip overhead. **No percentage');
  L.push('> gains are claimed** — this records current behaviour, including current gaps, and marks no fix as PASS.');
  L.push('');
  L.push('## Environment & parameters');
  L.push('');
  L.push(`- Collector SHA (HEAD at run time): \`${e.collectorSha}\``);
  L.push('  - The bench commit adds only `collector/bench/**` and a test; it changes no collector `src/`,'
    + ' so the measured hot-path code is identical to the pre-bench baseline `5b12638`.');
  L.push(`- Runtime: Node ${e.node}`);
  L.push(`- OS / arch: ${e.os} / ${e.arch}`);
  L.push(`- Hardware: ${e.cpuModel} ×${e.cpuCount}, ${mib(e.totalMemBytes)} MiB RAM`);
  L.push(`- Run: ${doc.quick ? '**quick/smoke** (reduced durations)' : 'full duration'}; selector \`${doc.scenarioSelector}\``);
  L.push(`- Steady config: ${c.warmupSec}s warmup + ${c.measureSec}s measured × ${c.reps} reps @ 50 events/s/device`);
  if (!doc.quick && (c.warmupSec < 30 || c.measureSec < 180 || c.reps < 3))
    L.push('- **Recorded durations were reduced from the 30 s warmup + 180 s × 3 reps default** because this'
      + ' environment kills long-running jobs. The runner defaults remain at the full spec; reproduce the full'
      + ' run with `--warmup 30 --measure 180 --reps 3` (see below). Counters/limits are duration-independent gates;'
      + ' the shorter windows only widen timing/RSS variance.');
  L.push(`- Store cap: ${e.maxEntriesPerDevice} entries/device (in-memory, no DB)`);
  L.push(`- Started ${doc.startedAt} → finished ${doc.finishedAt}`);
  L.push('');
  L.push('## WorkStats contract');
  L.push('');
  L.push('Every harness tracks `{ pendingBytes, pendingItems, activeJobs, received, applied, dropped }` against the');
  L.push('real component and asserts the invariant `received === applied + dropped + pendingItems` continuously, then');
  L.push('`stopAndDrain()` leaves `pendingBytes === 0` and `activeJobs === 0`. Retained bytes (queue + active + un-framed)');
  L.push('are reported separately from in-flight items. Overload/validation refusals count as `received` and `dropped`.');
  L.push('');
  L.push('**The 64-deep in-flight bound is a harness backpressure model, not a collector limit.** The collector at');
  L.push('HEAD has no such admission gate (that is exactly what O01/O02 add). Every `overload` drop below is the');
  L.push('bench harness shedding load once its own synthetic queue is full — read those figures as "what the drop');
  L.push('*accounting* looks like", never as current collector behaviour.');
  L.push('');
  L.push('**Nominal vs achieved rate.** Each scenario generates fixtures and processes them in the same paced');
  L.push('loop, so the *achieved* offered rate is below the nominal target (e.g. steady 1-dev lands well under');
  L.push('50 ev/s). Both are reported per scenario; the plan requires recording offer and real processing.');
  L.push('');
  L.push('**Memory is attributed by within-scenario delta, not absolute RSS.** All scenarios share one process,');
  L.push('so absolute RSS is a process-wide high-water mark that never falls — it is NOT a per-scenario cost.');
  L.push('Each scenario reports `heapUsed`/`external`/`rss` **deltas** measured from a GC\'d baseline at the window');
  L.push(`start (GC ${r.steady1?.repetitions?.[0]?.resource?.gcAvailable === false ? 'was NOT available — run with `--expose-gc` for a clean floor' : 'floor via --expose-gc'}); the delta is the attributable figure.`);
  L.push('');
  L.push('**Measurement notes.** An "event" is a fixture interaction that may expand to several protocol frames');
  L.push('(a WS event = 1 traffic + 8 message frames), so `received` counts frames offered, not logical events.');
  L.push('Event-loop delay is measured with a 10 ms-resolution histogram; under the paced (`setTimeout`) slices of');
  L.push('the steady/mixed scenarios it largely reflects idle timer granularity, so the meaningful head-of-line');
  L.push('signal is in the synchronous-work scenarios (burst, expansive gzip — which yields with `setImmediate`');
  L.push('so the gunzip cost is actually sampled).');
  L.push('');
  L.push('The full field set (including `arrayBuffers`, `heapTotal`, per-scenario p50/p95, loop delay, queue');
  L.push('peak/final for every scenario) is in the machine-readable `terminus-baseline.json` beside this file.');
  L.push('');

  const steadyBlock = (s: any) => {
    if (!s) return;
    L.push(`### ${s.scenario} (${s.deviceCount} device(s), nominal ${s.nominalRatePerDevice} ev/s/device)`);
    L.push('');
    L.push('| rep | achieved ev/s/dev | frames recv | applied | dropped | p50 ms | p95 ms | loopΔ mean/p99 ms | CPU % | ΔheapUsed MiB | Δexternal MiB | ΔarrayBuf MiB | peak pend items/bytes |');
    L.push('|----|----|----|----|----|----|----|----|----|----|----|----|----|');
    for (const rep of s.repetitions) {
      const st = rep.delta; const rs = rep.resource;
      L.push(`| ${rep.rep} | ${rep.achievedEventsPerSecPerDevice} | ${st.received} | ${st.applied} | ${st.dropped} | ${rep.latencyMs.p50} | ${rep.latencyMs.p95} | ${rs.loopDelayMeanMs}/${rs.loopDelayP99Ms} | ${rs.cpuPct} | ${mib(rs.heapUsedDeltaBytes)} | ${mib(rs.externalDeltaBytes)} | ${mib(rs.arrayBuffersDeltaBytes)} | ${rep.peakPendingItems}/${rep.peakPendingBytes} |`);
    }
    L.push('');
    L.push(`Nominal offered target ${s.nominalRatePerDevice} ev/s/device; achieved is lower (generation shares the paced loop). Per-rep \`received\`/\`applied\`/\`dropped\` are deltas for that ${s.measureSec} s window; Δmem is peak-minus-baseline within the window; the store persists across reps.`);
    L.push('');
    L.push(`Final after drain: received=${s.finalStats.received}, applied=${s.finalStats.applied}, dropped=${s.finalStats.dropped}, pendingBytes=${s.finalStats.pendingBytes}, activeJobs=${s.finalStats.activeJobs}, drainedClean=${s.drainedClean}.`);
    L.push(`Retention: ${s.retention.entries} entries, ${s.retention.wsSessions} ws sessions (${s.retention.wsFrames} frames), ${mib(s.retention.retainedBodyBytes)} MiB bodies, atMax=${s.retention.atMax}.`);
    L.push('');
  };
  L.push('## Steady offered load');
  L.push('');
  steadyBlock(r.steady1); steadyBlock(r.steady4);

  const one = (title: string, s: any, rows: [string, string][]) => {
    if (!s) return; L.push(`### ${title}`); L.push('');
    for (const [k, v] of rows) L.push(`- ${k}: ${v}`);
    if (s.note) L.push(`- Note: ${s.note}`);
    L.push('');
  };
  // Common per-scenario measurement rows from a harnessReport-shaped result.
  const hrRows = (s: any): [string, string][] => [
    ['latency p50 / p95 ms', `${s.latencyMs.p50} / ${s.latencyMs.p95} (n=${s.latencyMs.n})`],
    ['loop delay mean/p99/max ms', `${s.resource.loopDelayMeanMs} / ${s.resource.loopDelayP99Ms} / ${s.resource.loopDelayMaxMs}`],
    ['CPU %', String(s.resource.cpuPct)],
    ['Δmem heapUsed/external/arrayBuffers MiB', `${mib(s.resource.heapUsedDeltaBytes)} / ${mib(s.resource.externalDeltaBytes)} / ${mib(s.resource.arrayBuffersDeltaBytes)}`],
    ['peak pending items/bytes', `${s.peakPendingItems} / ${s.peakPendingBytes}`],
  ];
  L.push('## Isolated scenarios');
  L.push('');
  L.push('Absolute RSS is intentionally omitted from these rows (shared-process high-water); memory is the');
  L.push('within-scenario Δ. Full per-scenario fields are in `terminus-baseline.json`.');
  L.push('');
  if (r.burst) one('Burst (queue-full → explicit drop; 64-deep bound is a harness model)', r.burst, [
    [`nominal / achieved offered ev/s (${r.burst.durationSec}s)`, `${r.burst.nominalRatePerDevice} / ${r.burst.achievedOfferedEventsPerSec}`],
    ['achieved applied/s', String(r.burst.achievedAppliedPerSec)],
    ['frames offered/applied/dropped', `${r.burst.stats.received} / ${r.burst.stats.applied} / ${r.burst.stats.dropped}`],
    ['drop reasons (harness overload)', JSON.stringify(r.burst.dropReasons)],
    ['drained clean', String(r.burst.drainedClean)],
    ...hrRows(r.burst)]);
  if (r.framing) { L.push('### Fragmented framing (1 B / 64 B / 16 KiB chunks + truncated tail)'); L.push('');
    L.push('| chunk | received | applied | dropped | peak retained bytes | drained clean |');
    L.push('|----|----|----|----|----|----|');
    for (const v of r.framing.variants) L.push(`| ${v.chunkBytes} | ${v.finalStats?.received ?? '-'} | ${v.finalStats?.applied ?? '-'} | ${v.finalStats?.dropped ?? '-'} | ${v.peakUnframedPlusQueuedBytes ?? v.pendingBytesBeforeDrain ?? '-'} | ${v.drainedClean} |`);
    L.push(''); L.push('The truncated-tail row proves un-framed partial bytes are counted (`pendingBytesBeforeDrain > 0`) and discarded to 0 on `stopAndDrain()`.'); L.push(''); }
  if (r.gzip) one('Expansive gzip (tiny frame → large gunzip; setImmediate yield)', r.gzip, [
    ['frames / decompressed body each', `${r.gzip.count} / ${mib(r.gzip.decompressedBodyBytes)} MiB`],
    ['total wire bytes (compressed)', mib(r.gzip.totalWireBytes) + ' MiB'],
    ['applied / dropped', `${r.gzip.stats.applied} / ${r.gzip.stats.dropped}`],
    ...hrRows(r.gzip)]);
  if (r.mixed) one('Mixed rates (noisy + low-rate device sharing one FIFO)', r.mixed, [
    ['nominal noisy/quiet ev/s', `${r.mixed.nominalRates.noisyPerSec} / ${r.mixed.nominalRates.quietPerSec}`],
    ['achieved offered noisy/quiet ev/s', `${r.mixed.achievedOfferedPerSec.noisy} / ${r.mixed.achievedOfferedPerSec.quiet}`],
    ['applied / dropped', `${r.mixed.finalStats.applied} / ${r.mixed.finalStats.dropped}`],
    ['entries landed noisy / quiet', `${r.mixed.perDevice.noisy} / ${r.mixed.perDevice.quiet}`],
    ...hrRows(r.mixed)]);
  if (r.wsLong) one('Long WS session', r.wsLong, [
    ['frames appended', String(r.wsLong.framesAppended)],
    ['applied / dropped', `${r.wsLong.finalStats.applied} / ${r.wsLong.finalStats.dropped}`],
    ['retained ws frames', String(r.wsLong.retention.wsFrames)],
    ...hrRows(r.wsLong)]);
  if (r.clear) one('Clear then new events', r.clear, [
    ['rounds × perRound', `${r.clear.rounds} × ${r.clear.perRound}`],
    ['entries after each clear', JSON.stringify(r.clear.entriesAfterEachClear)],
    ['final entries retained', String(r.clear.retention.entries)],
    ['applied total', String(r.clear.finalStats.applied)],
    ...hrRows(r.clear)]);
  if (r.ui) one('UI fan-out (reading vs non-reading client)', r.ui, [
    ['offered events', String(r.ui.offeredEvents)],
    ['state publications = messages the reading client received', String(r.ui.statePublications)],
    ['reading client messages / bytes', `${r.ui.readingClient.messages} / ${mib(r.ui.readingClient.bytes)} MiB`],
    ['non-reading client peak server-buffered bytes (single sample)', mib(r.ui.nonReadingClientPeakBufferedBytes) + ' MiB']]);
  if (r.export) one('Export lease (HAR request cancelled mid-stream)', r.export, [
    ['entries in store', String(r.export.entries)],
    ['bytes delivered before cancel', mib(r.export.exportBytesBeforeCancel) + ' MiB'],
    ['cancelled / time-to-first-byte ms', `${r.export.cancelled} / ${r.export.timeToFirstByteMs}`],
    ['server still listening after cancel', String(r.export.serverStillListeningAfterCancel)],
    ['harness cancel: pending→dropped', `${r.export.harnessCancel.pendingBeforeCancel} → ${r.export.harnessCancel.cancelledDrops} (drained clean=${r.export.harnessCancel.drainedClean})`]]);
  if (r.legacy) one('Legacy own-protocol local cost (same fixture)', r.legacy, [
    [`nominal / achieved offered ev/s/dev`, `${r.legacy.nominalRatePerDevice} / ${r.legacy.achievedEventsPerSecPerDevice}`],
    ['messages received / applied / dropped', `${r.legacy.finalStats.received} / ${r.legacy.finalStats.applied} / ${r.legacy.finalStats.dropped}`],
    ['latency p50 / p95 ms', `${r.legacy.latencyMs.p50} / ${r.legacy.latencyMs.p95}`],
    ['loop delay mean/p99/max ms', `${r.legacy.resource.loopDelayMeanMs} / ${r.legacy.resource.loopDelayP99Ms} / ${r.legacy.resource.loopDelayMaxMs}`],
    ['CPU %', String(r.legacy.resource.cpuPct)],
    ['Δmem heapUsed/external MiB', `${mib(r.legacy.resource.heapUsedDeltaBytes)} / ${mib(r.legacy.resource.externalDeltaBytes)}`]]);

  L.push('## Pending measurements (owned by later tasks)');
  L.push('');
  L.push('- **Browser (UI) rendering**: row nodes mounted and time-to-visible-update require a real DOM and');
  L.push('  belong to the app/UI tasks (T06/T07). This baseline records only server-side fan-out (messages,');
  L.push('  bytes, state publications, non-reading-client buffered bytes).');
  L.push('- **Native device**: time-to-first-byte and app completion, device CPU/memory, and work with capture');
  L.push('  **off vs on** are measured on-device by T04/T05/T12 and are intentionally absent here.');
  L.push('- **End-to-end transport comparison**: the legacy own-protocol figures are local hot-path cost only.');
  L.push('  A fair TLS v2 vs legacy comparison must add TLS + auth-v2 handshake cost explicitly and must not');
  L.push('  claim transport equivalence.');
  L.push('');
  L.push('## Raw data');
  L.push('');
  L.push('`docs/superpowers/validation/terminus-baseline.json` (committed beside this report) holds every');
  L.push('field for every scenario — the source of truth this Markdown summarises.');
  L.push('');
  L.push('## How to reproduce');
  L.push('');
  L.push('```');
  L.push('cd collector && npm ci');
  L.push('# --expose-gc gives each scenario a clean memory baseline; defaults encode the full spec');
  L.push('# (30 s warmup + 180 s x 3). This report used reduced windows (see above) via --warmup/--measure/--reps.');
  L.push('NODE_OPTIONS=--expose-gc npm run bench -- --scenario all \\');
  L.push('  --output docs/superpowers/validation/terminus-baseline.json \\');
  L.push('  --report docs/superpowers/validation/terminus-performance.md');
  L.push('# full spec: add --warmup 30 --measure 180 --reps 3   |   smoke/CI: add --quick');
  L.push('```');
  L.push('');
  return L.join('\n');
}

// Only run when invoked as a script (`tsx bench/run.ts`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
