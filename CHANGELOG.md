# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

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

### Changed

- Pairing advertises the LAN IPv4 address instead of the unresolvable hostname, and
  rotates it when the DHCP-assigned address changes. Override it with
  `TERMINUS_PAIRING_HOST`; `terminus pair` surfaces the advertised host and warns on
  drift.
- Atlantis traffic is aliased onto the app's ingest `deviceId`, so a device seen on
  both channels is a single device record.
- The `@terminus/cli` package now declares its license (`MIT`), matching the
  collector package.

### Fixed

- Body budget pressure now evicts the oldest entries (down to a floor of 100)
  before admitting a new body, instead of permanently omitting bodies once the
  64 MiB budget filled; evictions are counted as `evictedForBodyBudget`.
- Rejected device authentication on the ingest WSS is now logged (rate-limited,
  token never printed) and counted in `ingest.rejectedDeviceAuth`.
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
