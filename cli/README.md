# @terminus/cli

`terminus` — a terminal client for a local [Terminus](../collector) collector. It
talks to the collector's HTTP/WebSocket API on `127.0.0.1:8787` and covers what the
dashboard does, without a browser: live tail, list, inspect, export, pause, devices,
and pairing (with a QR rendered in the terminal).

No CLI framework and no runtime dependencies beyond `ws` (already used by the
collector). TypeScript compiled with `tsc`; Node ≥ 20.

## Install / build

From the monorepo root:

```sh
npm install
npm run build -w @terminus/cli    # emits cli/dist/cli/src/cli.js
```

### Getting `terminus` on your PATH

`prepare` runs the build automatically, so any of these produce a working `terminus`
without a separate build step:

```sh
npm link -w @terminus/cli    # symlinks `terminus` into your global bin (dev)
npm install -g ./cli         # installs it globally from the local package
npx --prefix cli terminus …  # run without installing
```

Or run the built entry directly, without the `terminus` name:

```sh
node cli/dist/cli/src/cli.js status
```

### Why `dist` is nested (`dist/cli/src/cli.js`)

The CLI reuses a few pure modules from the collector (the QR encoder, `toQrPairing`,
`toCurl`, the state-dir resolver, protocol types) by importing their source directly.
With no bundler (a deliberate choice — zero runtime deps beyond `ws`), `tsc` roots the
compilation at the monorepo root so those shared sources compile in place alongside
the CLI. The emitted tree therefore mirrors the repo: `dist/cli/src/…` and
`dist/collector/src/…`. `bin` points at `dist/cli/src/cli.js` (a tiny shebang entry
that calls the CLI), so callers just type `terminus` and never see the nested path.

## Connection & authentication

The collector binds loopback only. The CLI connects to `--host`/`--port`
(default `127.0.0.1:8787`), overridable with `TERMINUS_HOST` / `TERMINUS_PORT`.

The admin token is resolved in this order:

1. `--token <t>`
2. `TERMINUS_TOKEN`
3. the `admin-token` file the running collector writes in its state dir
   (`~/Library/Application Support/Terminus/admin-token`, or `TERMINUS_STATE_DIR`).

With none of these you get:
`no token: pass --token, set TERMINUS_TOKEN, or run the collector on this machine`.

## Commands

| Command | What it does |
|---|---|
| `terminus status` | Collector snapshot over the /ui socket: devices, live-window counts, paused, protocol version, retention. `--json` for the raw snapshot. |
| `terminus tail [filters]` | Connect to /ui, print the last N entries (`--last 50`) then follow live traffic. One line per entry (time, device, method, status, duration, host+path); WebSocket/SSE frames as `WS ↑/↓`. Ctrl-C stops cleanly. `--json` emits NDJSON of every event. |
| `terminus ls [filters]` | `GET /api/entries` (paged). `--limit N`, `--all`. Same columns as `tail`. |
| `terminus show <deviceId>/<entryKey>` | One entry: request/response headers, timing, and bodies (pretty JSON when JSON, text when textual, `<binary N bytes>` otherwise). `--body request\|response\|none`, `--curl` prints a reproduction curl. |
| `terminus export [--har\|--json] [-o file]` | Download the capture as HAR (default) or JSON; stdout unless `-o`. |
| `terminus pause` / `terminus resume` | Toggle the live stream (`POST /api/pause` with `{paused}`). |
| `terminus clear [--device <id>]` | Drop captured data, optionally for one device. |
| `terminus devices` | List paired devices: id, platform, app version, build profile, last seen, dropped. |
| `terminus pair [--qr] [--json]` | Show the pairing. `--json` prints the QrPairing blob to paste into the app; `--qr` renders it as a scannable QR (Unicode half-blocks) — the QR contains the device token, so it prints a red warning. |

### Common filters (`tail`, `ls`)

`--device <id>` · `--method GET,POST` · `--status 4xx|5xx|200` · `--host <substr>`
· `--path <substr>` · `--errors`

> In `tail` and `ls`, `--host` is the traffic host **filter**. Set a non-loopback
> connection host for these two commands with `TERMINUS_HOST` instead.

## Output

- Aligned tables adapted to the terminal width; the host+path column truncates with `…`.
- Status codes are coloured (2xx green, 3xx blue, 4xx yellow, 5xx red); colour is off
  when stdout is not a TTY or `NO_COLOR` is set.
- Errors go to stderr. Exit codes: `1` general, `2` authentication, `3` collector
  unreachable (with the hint `is the collector running? npm start in collector/`).

## Examples

```sh
terminus status
terminus ls --status 4xx,5xx --host api.example.com
terminus tail --device pixel-8 --method POST --errors
terminus show pixel-8/r1 --curl
terminus export --har -o capture.har
terminus pair --qr
```

## Tests

```sh
npm test -w @terminus/cli        # vitest, drives commands against a real collector
npm run typecheck -w @terminus/cli
```

The tests spin up a real collector on an ephemeral loopback port via the collector's
own test harness (`collector/test/fixtures/harness.ts`) and run the command functions
in-process, so nothing binds the live collector's fixed ports.
