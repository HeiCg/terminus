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
| `terminus tail [filters]` | Connect to /ui, print the last N entries (`--last 50`) then follow live traffic. One line per entry (time, device, method, status, duration, host+path); WebSocket/SSE frames as `WS ↑/↓`. Ctrl-C stops cleanly. `--json` emits NDJSON of every event. Reconnects automatically with exponential backoff after a dropped connection (`--no-reconnect` to disable). |
| `terminus ls [filters]` | `GET /api/entries` (paged). `--limit N`, `--all`. Same columns as `tail`. With filters, `--limit N` pages through the store to gather up to N matches (not just the first page). |
| `terminus show <deviceId>/<entryKey>` | One entry: request/response headers, timing, and bodies (pretty JSON when JSON, text when textual, `<binary N bytes>` otherwise). `--body request\|response\|none`, `--curl` prints a reproduction curl. |
| `terminus replay <deviceId>/<entryKey>` | `POST /api/replay`: re-send a captured request from the collector's machine and store the result as a new `replay` entry. Overrides: `--method`, `--url`, `--header K:V` (repeatable), `--body <string>`, `--body-file <path>`. Credentials are **stripped by default** (auth headers/cookies and token query params); `--with-credentials` re-sends them. Prints the outcome status, duration, the new entry key, and any `stripped:` names; `--json` emits the endpoint response. **The request leaves your machine** — see the security note. |
| `terminus export [--har\|--json] [-o file]` | Download the capture as HAR (default) or JSON; stdout unless `-o`. |
| `terminus pause` / `terminus resume` | Toggle the live stream (`POST /api/pause` with `{paused}`). |
| `terminus clear [--device <id>]` | Drop captured data, optionally for one device. |
| `terminus devices` | List paired devices: id, platform, app version, build profile, last seen, dropped. |
| `terminus pair [--qr] [--json]` | Show the pairing. `--json` prints the QrPairing blob to paste into the app; `--qr` renders it as a scannable QR (Unicode half-blocks) — the QR contains the device token, so it prints a red warning. |
| `terminus completion <bash\|zsh\|fish>` | Print a shell completion script generated from the command/flag tables. Offline (no collector needed). |

### Help & version

- `terminus --version` (or `-V`) prints the CLI version.
- `terminus <command> --help` prints that command's own flags (e.g. `terminus ls --help`);
  `terminus --help` prints the global usage.
- Unknown flags and malformed values fail fast with exit `1` and a message
  (`unknown flag --stauts (did you mean --status?)`, `flag --limit expects a number`,
  `invalid --status: …`).

### Reconnecting tail

`tail` retries a dropped connection with exponential backoff (1s, 2s, 4s … capped at
15s, jittered), printing `reconnecting…`/`reconnected` to stderr — or, under `--json`,
a `{"event":"reconnect","state":…}` line on stdout. The reconnect snapshot never
reprints entries already shown. `--no-reconnect` restores the old behaviour (exit `3`
on a dropped connection). Ctrl-C always exits cleanly.

### Common filters (`tail`, `ls`)

`--device <id>` · `--method GET,POST` · `--status 4xx|5xx|200` · `--host <substr>`
· `--path <substr>` · `--source xhr|atlantis|proxy|replay` · `--errors`

> In `tail` and `ls`, `--host` is the traffic host **filter**. Set a non-loopback
> connection host for these two commands with `TERMINUS_HOST` instead.

### Shell completion

Generate and install completion for your shell (commands, per-command flags, and
enum values like `--status`, `--source`, `--body`):

```sh
# bash: add to ~/.bashrc
eval "$(terminus completion bash)"
# zsh: add to ~/.zshrc
eval "$(terminus completion zsh)"
# fish
terminus completion fish | source
```

### Replay is a real request

`terminus replay` re-sends the captured request from the collector's machine to
the original host. **Captured credentials are stripped by default** — the
`authorization`/`cookie` headers, `x-*` token/secret/key/auth headers, and
credential-bearing query params are removed before the request leaves, and the
removed names are printed (`stripped: authorization, cookie`). Pass
`--with-credentials` to re-send them verbatim. The response is stored as a new
entry with `source: replay` and a `replayOf` back-reference to the original — it is
never merged into the original. Even without credentials, a replay re-issues the
request, so a non-idempotent request repeats its side effect. Only replay what you
intend to send again.

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
terminus replay pixel-8/r1 --header 'x-debug: 1'
terminus export --har -o capture.har
terminus completion zsh > ~/.terminus-completion.zsh
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
