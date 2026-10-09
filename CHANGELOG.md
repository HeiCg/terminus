# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

## 0.2.0 — 2026-10-08

### Added

- Server sequence for HTTP entries: every entry write takes the next per-store
  `seq`; summaries carry `seq`, `firstSeq` and `receivedAt` (collector clock).
  `GET /api/entries?afterSeq=<n>` reads entries changed after a cursor in arrival
  order, and `?last=<n>` (1 to 200) the most recent ones, both with `nextSeq`,
  `lastSeq`, `epoch`, `now`, `gap` and `hasMore`. `newOnly=true` keeps only entries
  created after the cursor. A per-boot `epoch` makes a cursor from another boot a
  `409 stale_cursor`; `gap` reports records evicted or cleared past the cursor.
  `GET /api/status` gains `epoch`, `lastSeq` and `now`.
- Reader token: a second per-boot bearer written to `<stateDir>/reader-token`
  (`0600`, removed on shutdown), limited by an explicit allowlist to `GET` reads of
  `/health`, `/api/status`, `/api/devices`, `/api/entries/*` and `/api/ws/*`;
  anything else answers `403 {"error":"forbidden_scope","required":"admin"}`.
  `terminus status` and `ls` accept it in `TERMINUS_TOKEN`; admin-only commands
  say so and exit 2.
- Device and app identity: devices carry `bundleId`, `appName`, `deviceName`,
  `model` and `externalId` from the Atlantis ConnectionPackage (including the
  forks' new `device.externalId`) or from new optional `hello` fields, plus the
  sticky flags `ambiguous` (two live Atlantis connections announcing one id) and
  `startEvents` (the device sends request-start events). An Atlantis request-start
  packet (the forks' `emitRequestStart`) that arrives after its exchange already
  completed is dropped instead of overwriting the completed entry.
- Device-scope filters `device=`, `externalId=` and `bundleId=` on
  `GET /api/entries` (every mode), `GET /api/entries/wait` and `GET /api/devices`;
  the seq reads echo the resolved set as `devices` when `externalId` or `bundleId`
  is given.
- `GET /api/pairing?host=<h>` overrides the advertised host for that response, for
  a simulator or emulator pairing against `127.0.0.1`; a host outside the
  certificate SAN is `400`.
- Entry filters on the `afterSeq` and `last` reads: `method` (list), `urlContains`,
  `status` (code, class or range), `source` and `completed`.
- `GET /api/entries/wait`: a long-poll that answers as soon as an entry after
  `afterSeq` matches the scope and filters, or after `timeoutMs` (default 10 s, at
  most 30 s) with up to 5 `nearMisses`. At most 16 pending waits collector-wide
  (`429` beyond); disconnect, clear and shutdown end a wait.
- `apiVersion` (1) and `capabilities` (`seq`, `reader-token`, `device-identity`,
  `filters`, `wait`, `redaction-marker`) on `GET /health` and `GET /api/status`,
  for feature detection.
- Redaction marker: every entry carries `redacted: { request, response }` in the
  read API, the HAR export (`_terminus.redacted`) and the JSON export, and `--load`
  restores it. `TERMINUS_REDACT_EXTRA` and `TERMINUS_REDACT_ALLOW` add or exempt
  names (comma-separated, case-insensitive; `authorization`, `cookie`, `set-cookie`
  and `proxy-authorization` cannot be exempted).
- `docs/read-api.md`: the HTTP read contract for automation clients.

### Changed

- Redaction is wider by default. Names are matched by word against a shared list
  (`password`, `secret`, `token`, `session`, `api` + `key`, `card` + `number`, and
  more), JSON bodies are walked by key at any depth, and form bodies are masked by
  parameter name. More values now show as `***` in the UI, the CLI, exports and
  stored data, including pagination tokens such as `nextPageToken`; set
  `TERMINUS_REDACT_ALLOW` to exempt a name. The replay credential strip uses the
  same matcher, so a default replay drops more names, and a `credentials: 'keep'`
  replay re-sends `***` for values masked at capture.
- Query-parameter redaction is now case-insensitive.
- `GET /api/devices?device=` now filters the list (it was ignored), and `device=`
  on `GET /api/entries` resolves an Atlantis alias to its canonical device.
- `terminus status` with a reader token reports from `GET /api/status` only (the
  `/ui` socket is admin-only); `--json` carries `snapshot: null`.

### Fixed

- Replay results were stored without redaction; the stored replay entry (both
  sides) now goes through the same redactor as captured traffic and carries the
  `redacted` marker. The outgoing request is unchanged.
- The HAR fixture drift test no longer breaks on every release (it ignores
  `creator.version`).
- The missing-OpenSSL startup error now gives a macOS and a Linux hint instead of
  naming only Homebrew, and the version-too-old error gives the same hints.
- `identity:rotate --ip ...` no longer drops `127.0.0.1` and `::1` from the
  certificate SAN; the loopback anchors are always kept, like `localhost`, so
  simulator and emulator pairing on loopback keeps working after a rotation.
- WebSocket sessions captured by the proxy stored their URL unredacted (a token in
  the query was served by `/api/ws` and exports); the URL now goes through the
  same redaction as HTTP entries.

## 0.1.1 — 2026-09-14

### Added

- UI search mini-query: the Capture search box parses `method:`, `status:` (code,
  `5xx` class, or `400-499` range), `host:`, `path:`, `source:`, `device:` and
  `body:` terms (quote for spaces, free text otherwise) and ANDs them with the
  filter chips.
- Shareable Capture URLs: the device, filter chips, sort and search are serialized
  into the location hash and restored on reload (`history.replaceState`).
- WebSocket frame search: the frame inspector finds text matches across the loaded
  frames with an "N of M" counter and next/prev navigation (Enter / Shift+Enter);
  binary frames never match.
- Keyboard-shortcut sheet: `?` (or ⌘/Ctrl-`/`) opens a dialog listing every
  shortcut, also reachable from the command palette.
- Per-device capture channels: each device record now tracks which channels it
  arrived on (in-app ingest over WSS vs the Atlantis wire protocol). The Devices
  view shows channel chips and `terminus devices` gains a `CHANNELS` column.
- Ingest back-pressure: a burst on the ingest WSS is paused rather than dropped or
  closed, with the pause budget tunable via `TERMINUS_INGEST_PAUSE_MAX_MS`.
- Resumed WebSocket sessions: sessions are synthesized from orphan frames after a
  reconnect, surfaced with a dedicated DTO, a UI chip, and CLI `ws:?` rendering.
- Periodic Atlantis ping: the collector sends a periodic ping control frame on the
  Atlantis channel, tunable via `TERMINUS_ATLANTIS_PING_MS`.
- `GET /api/status` (authenticated) reports version, uptime, pause state, connected
  devices, retention counters, body-store stats, and ingest scheduler stats.
  `terminus status` consumes it; `terminus status --json` now emits
  `{ snapshot, status }`.
- `terminus --version` / `-V`, and per-command `--help` (`terminus ls --help`).
- `terminus tail` reconnects with exponential backoff when the collector drops the
  connection or restarts, without reprinting entries already shown;
  `--no-reconnect` restores the fail-fast exit 3.
- ESLint now covers `collector/src` and `collector/test`; CI runs on Ubuntu and
  macOS with npm caching; `LICENSE` ships in both packages; Dependabot, issue
  templates, and CODEOWNERS added.
- Log levels: `log.debug` plus `TERMINUS_LOG_LEVEL` (`debug|info|warn|error`, default
  `info`; an invalid value falls back to `info` with a warning). Every line now
  carries an ISO-8601 timestamp and the level, e.g.
  `[terminus] 2026-09-14T10:00:00.000Z WARN ...`.
- Crash-loop guard: a single `uncaughtException`/`unhandledRejection` is still logged
  and swallowed, but reaching `TERMINUS_CRASH_THRESHOLD` (default `5`) within 60 s now
  triggers a clean shutdown (state lock released, `admin-token` removed) with exit 1.
- Certificate expiry warning: at boot the collector warns when the identity
  certificate is within 30 days of expiry, naming the date and the rotate command.
- Run as a macOS service: `collector/scripts/launchd/` ships a launchd plist template
  with `install.sh`/`uninstall.sh`, and the README gains a "Run as a service (macOS)"
  section.
- `docs/ingest-protocol.md`: the WSS capture protocol (pairing, connection, message
  types, back-pressure/close codes, and a minimal Node client) for instrumenting
  your own app without the Atlantis SDK.
- `docs/troubleshooting.md`: fixes for certificate/SHA mismatch, an unreachable LAN
  IP, `EADDRINUSE`, a stale `admin-token`, missing OpenSSL, QR pairing on a
  hardened QA build, and `terminus tail` reconnect behaviour.
- A single **Configuration** table in the collector README documenting every
  collector and CLI environment variable, with defaults, scope, and the deprecated
  `NETCAPTURE_*` aliases; `docs/architecture.md` now points to it.
- **Distribution** and **Releasing** sections in `CONTRIBUTING.md` (packages are
  private; install from source; release is a git tag with a version bump and
  changelog roll-over).

- Request replay: `POST /api/replay` and `terminus replay <device>/<id>` re-send a
  captured request from the collector's machine (with optional `--method`/`--url`/
  `--header`/`--body` overrides) and store the result as a new entry with
  `source: replay` and a `replayOf` back-reference. A **Replay** button on the detail
  panel does the same from the UI.
- Import a capture at start: `node dist/main.js --load <file.har|file.json>`
  (repeatable) preloads a Terminus HAR or JSON export into the store, creating
  synthetic devices as needed; the collector also accepts `--help`/`--version`.
- Shell completion: `terminus completion <bash|zsh|fish>` prints a completion script
  generated from the command/flag tables (commands, per-command flags, and enum
  value sets for `--status`/`--source`/`--body`).
- `terminus ls`/`tail` gain a `--source xhr|atlantis|proxy|replay` filter.
- `TERMINUS_BODY_BUDGET` makes the bodies retention budget configurable (a positive
  byte count, optional binary `k`/`m`/`g` suffix; default 64 MiB); an invalid value
  is fatal at start.
- Svelte MCP server configuration (`.mcp.json`, committed): points at
  `https://mcp.svelte.dev/mcp` for Svelte 5 guidance when working on the UI.

### Changed

- HAR export now writes a `_terminus` identity extension on every HTTP entry
  (`deviceId`, `id`, `source`, and `replayOf` when present), so `--load` re-imports a
  Terminus HAR **losslessly** — entries return to the device/id/source they were
  captured under instead of a synthetic `har:<basename>` device. Linked WS/SSE
  sessions ride `_terminus.sessions`. A third-party HAR (no `_terminus`) still
  imports best-effort.
- Replay now removes captured credentials by default before re-sending: the
  `authorization`, `cookie`, `proxy-authorization`, `x-api-key`, `x-auth-token`
  headers, any `x-*` header naming a token/secret/key/auth, and credential-bearing
  query params (`token`, `access_token`, `api_key`, `apikey`, `key`, `auth`,
  `signature`, `sig`) are stripped, and the removed names are reported as `stripped`.
  `POST /api/replay` gains a `credentials: 'strip' | 'keep'` field (default `strip`)
  and a `stripped` result; `terminus replay --with-credentials` and the UI's "Include
  captured credentials" toggle (a confirming second click) restore the verbatim
  re-send. Headers passed explicitly via `overrides.headers` are never stripped.
- Every state-changing route now shares one Origin/CSRF gate (`requireMutation`):
  a cookie session requires an exact loopback Origin, a bearer CLI caller is exempt,
  and `DELETE /api/session` (cookie-only) always requires an Origin.
- Pairing advertises the LAN IPv4 address instead of the unresolvable hostname, and
  rotates it when the DHCP-assigned address changes. Override it with
  `TERMINUS_PAIRING_HOST`; `terminus pair` surfaces the advertised host and warns on
  drift.
- Atlantis traffic is aliased onto the app's ingest `deviceId`, so a device seen on
  both channels is a single device record.
- Ports now resolve `TERMINUS_PORT`, `TERMINUS_INGEST_PORT` and `TERMINUS_ATLANTIS_PORT`
  (each with the deprecated `NETCAPTURE_*` fallback and a one-time warning); the bare
  `PORT`/`INGEST_PORT`/`ATLANTIS_PORT` spellings stay accepted as legacy. Invalid-port
  errors name the spelling actually read.
- The `@terminus/cli` package now declares its license (`MIT`), matching the
  collector package.

### Fixed

- Body budget pressure now evicts the oldest entries (down to a floor of 100)
  before admitting a new body, instead of permanently omitting bodies once the
  64 MiB budget filled; evictions are counted as `evictedForBodyBudget`.
- Rejected device authentication on the ingest WSS is now logged (rate-limited,
  token never printed) and counted in `ingest.rejectedDeviceAuth`. A rejected Atlantis
  connection (bad device token) now increments the same counter, not just a log line.
- `/health`, the HAR creator, and the boot banner report the real `package.json`
  version instead of a hardcoded string.
- `terminus ls --limit N` with filters pages through the store until N matches
  instead of filtering a single page. Unknown flags and invalid `--limit`,
  `--last`, `--status`, and `--body` values now fail with exit 1.
- "Jump to newest" pill now appears under any non-time sort, not only the default.
- A pill announces new arrivals on devices other than the selected one, and the
  capture view shows an explicit cross-device empty state.
- The topbar connection dot is always visible, reflecting the live connection state.
- The body pane shows an explicit "Empty body (0 bytes)" card for a captured empty
  body instead of a blank pane that read as still-loading.
- The ingest build profile is preserved over channel placeholders on the device
  record.

## 0.1.0 — initial public release

- Local Mac collector capturing HTTP and WebSocket/SSE traffic from devices on the
  LAN, held in memory and shown in a loopback Svelte 5 web UI.
- Two device capture channels: the in-app protocol over WSS (`8788`) and the
  Atlantis wire protocol over TLS (`10909`), both requiring the collector's pinned
  certificate and a per-device token.
- Device pairing by paste (the authenticated UI's `GET /api/pairing`) and by QR,
  with a public `GET /api/cert` endpoint whose certificate is verified against the
  QR's SHA-256 before pairing.
- Loopback-only UI with a DNS-rebinding `Host`/`Origin` check, an ephemeral admin
  token per start, and cookie sessions.
- `terminus` CLI (`cli/`): a browser-free client for the local collector — live
  `tail`, `ls`, `show` (with `--curl`), `export`, `pause`/`resume`, `clear`,
  `devices`, and `pair` (`--json`/`--qr`, QR rendered in the terminal). The repo is
  now an npm workspace (`collector` + `cli`) with root `test`/`typecheck`/`lint`.
- Admin-token file: the collector writes its per-boot admin token to `admin-token`
  in the state dir (`0600`, atomic, removed on clean shutdown) so the CLI can
  authenticate on the same machine without copying a token.
- State directory now follows OS conventions: macOS Application Support, Windows
  `%LOCALAPPDATA%`, Linux `$XDG_STATE_HOME`; `argo-netcapture` migration is macOS-only.
- Header, URL-query, and body redaction of known auth material, applied before
  capture data is stored.
- HAR 1.2 and JSON export, streamed from an immutable snapshot under a body lease,
  with terminus-specific `_`-extensions for bodies, WebSocket, and SSE.
- Optional, off-by-default MITM proxy source with its own CA and a required client
  allowlist.
- Persistent collector identity with atomic writes, a state-dir lock, and one-time
  automatic migration from the previous `argo-netcapture` state directory.
