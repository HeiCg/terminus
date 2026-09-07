# Terminus collector — synthetic load & resource baseline

This bench records a **reproducible baseline** of the collector's hot paths using
**deterministic synthetic fixtures on loopback only**. It measures the code at the
current commit as a fixed reference point, so a later change can be compared against
the same fixtures on the same harness.

It never uses real capture data. Every host is `bench.invalid`, every token is an
obvious fake (`Bearer bench-…`) present only so the redactor has something to mask.
Nothing here writes bodies, headers or tokens to the output — only aggregate counters.

## What it drives

Real collector components, wired exactly as the servers wire them (no debug endpoints,
no changes to `src/`):

- **Atlantis TLS v2 hot path** — `FrameAccumulator` (8-byte LE reassembly) → `gunzip`
  → `JSON.parse` → redaction (`redactEntry`/`redactText`) → `Store`.
- **Legacy own-protocol path** — `JSON.parse` → `isDeviceMessage` → `Store.applyDeviceMessage`.
  Reported as *local hot-path cost only*: it excludes TLS and auth-v2 handshake cost and
  is **not** an end-to-end transport comparison.
- **UI fan-out** — the real `createHttpServer` on `127.0.0.1`, a reading `/ui` client and
  a client that stops reading (server-side buffered bytes grow).
- **HAR export** — a real `/export.har` request cancelled mid-stream.

## WorkStats contract

Each harness tracks the real component's counters and closes its own input:

```ts
type WorkStats = {
  pendingBytes: number; pendingItems: number; activeJobs: number;
  received: number; applied: number; dropped: number;
};
// invariant, asserted continuously:
received === applied + dropped + pendingItems
// after closing input:
await harness.stopAndDrain();
harness.stats().pendingBytes === 0 && harness.stats().activeJobs === 0
```

- `received` includes items refused by overload/validation.
- `pendingItems` includes active jobs not yet applied; `pendingBytes` is **retained**
  bytes (un-framed accumulator bytes + queued + in-flight), distinct from in-transit items.
- Partial framing bytes are counted even without a complete message.
- `cancelAndDrain()` accounts queued items as `dropped` (`cancelled`) and does **not**
  free a job already in use — it finishes.

These helpers live only in the bench harness, never in a public SDK API.

> **The 64-deep in-flight bound (`maxInFlight`) is a harness backpressure model, not a
> collector limit.** It lives only in the bench harness; the collector applies its own
> admission and byte budgets elsewhere. Every `overload` drop the bench reports is the
> harness shedding load once its own synthetic queue is full; read those numbers as drop
> *accounting*, never as production collector behaviour. Likewise the reported *achieved*
> offered rate is below the nominal target because each scenario generates and processes
> fixtures in the same paced loop.

> **Memory is attributed by within-scenario delta.** All scenarios share one process, so
> absolute RSS is a process-wide high-water mark, not a per-scenario cost. Run with
> `NODE_OPTIONS=--expose-gc` so each scenario gets a GC'd baseline; the report shows
> `heapUsed`/`external`/`arrayBuffers` deltas from that baseline.

## Scenarios (`--scenario`)

| selector | what it exercises |
|----|----|
| `steady`  | 1 and 4 devices, 50 events/s/device, HTTP+WS+SSE mix; warmup + N reps |
| `burst`   | 1000 events/s in 100 ms spikes → 64-deep buffer overflow → explicit drops |
| `framing` | same frames in 1 B / 64 B / 16 KiB chunks + a truncated-tail partial frame |
| `gzip`    | tiny gzip payloads that expand to 1 MiB bodies on decode (gunzip CPU) |
| `mixed`   | one noisy device + one low-rate device sharing a single FIFO pipeline |
| `ws`      | one long WS session, many frames appended over time |
| `clear`   | clear followed by new events, N rounds (retention released, counters continue) |
| `ui`      | reading client vs client that stops reading (server buffered bytes) |
| `export`  | HAR export cancelled mid-stream + harness cancellation accounting |
| `legacy`  | own-protocol local cost on the same fixture |
| `all`     | everything above |

Bodies of 0 B, 1 KiB, 64 KiB and 1 MiB and a UTF-8/binary mix all appear; the sustained
scenarios skew small (1 MiB ≈ 2 %) so retention stays realistic, while `gzip`/`export`
force the large sizes.

## Run

Install once from the repository root (`npm ci`), then run the bench in the
`collector` workspace. `collector/bench/out/` is the conventional (git-ignored)
output directory.

```bash
npm ci   # from the repo root — installs both workspaces

# full baseline (defaults: 30 s warmup + 180 s × 3 reps @ 50 ev/s/device).
# --expose-gc gives each scenario a clean memory baseline.
NODE_OPTIONS=--expose-gc npm run bench -w collector -- --scenario all \
  --output collector/bench/out/baseline.json \
  --report collector/bench/out/performance.md

# reduced windows (when full durations are impractical)
NODE_OPTIONS=--expose-gc npm run bench -w collector -- --scenario all --warmup 10 --measure 45 --reps 3

# a single scenario
npm run bench -w collector -- --scenario burst

# quick smoke (seconds, not minutes)
npm run bench -w collector -- --scenario all --quick
```

`--warmup/--measure/--reps` override the steady window; `--output` and `--report` choose
where the JSON and Markdown go (with neither, JSON prints to stdout).

`--output <file>` writes the raw JSON; `--report <file>` writes the aggregated Markdown
report; with neither, the JSON is printed to stdout. A compact summary is always printed.

Counters and limits are deterministic gates. Wall time, CPU %, event-loop delay and RSS
are separate measurements with real variability (and include runtime/parsing/gzip
overhead); time-based scenarios vary by ±1 slice run to run. No percentage gain is claimed.

## Out of scope here

- Browser rendering (row nodes mounted, time-to-visible-update) — that needs a real DOM
  and is covered by the Playwright suite, not this bench.
- On-device measurements (time-to-first-byte, app completion, CPU/memory, capture off vs
  on) — these belong to app-side benchmarking, not the collector bench.
- This harness introduces no SQLite, worker pool, global body index, or virtualization
  library; it exercises the collector as it ships.
