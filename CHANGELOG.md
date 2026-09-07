# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/).

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
