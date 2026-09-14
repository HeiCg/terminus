# Terminus (collector)

The Terminus collector is a local Mac server that captures HTTP and WebSocket
traffic from your devices on the LAN, shows it live in a web UI, and exports it as
HAR 1.2. Device capture runs over **TLS with device-token auth** on the LAN, while
the UI stays loopback-only. This README covers running and operating the collector;
for the project overview see the [repository README](../README.md), for the
design see [docs/architecture.md](../docs/architecture.md) and
[docs/security.md](../docs/security.md), for instrumenting your own app against the
capture channel see [docs/ingest-protocol.md](../docs/ingest-protocol.md), and when
something goes wrong see [docs/troubleshooting.md](../docs/troubleshooting.md). The
collector accepts two capture protocols:

- **Own protocol** over WSS (`wss://<host>:8788/ingest`) — the in-app instrumentation.
- **Atlantis** over TLS (port `10909`) — the Atlantis iOS/Android forks. The device's
  `ConnectionPackage` carries `passcode=<deviceToken>`; the server answers with a
  `ready` (or `auth_error`) control frame before replay.

Both channels require the collector's pinned certificate **and** the device token;
neither exists on the loopback UI listener. Everything is kept **in memory** (no
database), capped at 5 000 HTTP entries per device.

## Requirements

- Node.js ≥ 20
- OpenSSL 3 on `PATH` (used once to generate the collector's identity certificate).
  Checked at startup; a missing/old OpenSSL is a hard, actionable error before any
  listener opens.

## Run

```bash
cd collector
npm install
npm start            # builds and starts on http://localhost:8787
```

`npm start` rebuilds every time. Once you have a build, `npm run start:built`
launches the compiled server (`dist/main.js` + `dist-ui/`) **without** rebuilding;
if the tree was never built it prints a one-line `npm run build` instruction and
exits non-zero instead of starting a half-broken server.

On start, the collector prints a URL carrying the admin token in the fragment, e.g.
`http://127.0.0.1:8787/#token=<adminToken>`.

The browser UI reads the `#token` fragment, trades it for the session cookie via
`POST /api/session`, and strips the fragment from the URL before any request — no
token ever reaches browser storage, logs or a query string. If the session is
missing or expires, the UI shows a login screen instead of reconnecting in a
silent loop. You can still drive the collector with the admin bearer directly
(e.g. `curl` with `Authorization: Bearer <adminToken>`).

The topbar search box takes a mini-query as well as a plain substring: space-separated
`key:value` terms filter by `method:` (comma-separated list), `status:` (a code like
`404`, a class like `5xx`, or a range like `400-499`), `host:`, `path:`, `source:`
(`xhr|atlantis|proxy`), `device:`, and `body:` (over already-loaded response/request
bodies); quote a value to include spaces (`host:"api v2"`), and any token without a
known `key:` is matched as a free substring over the request's method and URL. Query
terms combine with the filter-bar chips using AND. The active device, chips, sort and
search are mirrored into the URL hash, so a filtered view is bookmarkable and
shareable, and it is restored on reload. Press `?` (or ⌘/Ctrl-`/`) for a sheet listing
every keyboard shortcut; in the WebSocket frame inspector the search box finds matches
within the loaded frames and steps through them with Enter / Shift+Enter.

The collector also writes the current admin token to `admin-token` in the state dir
(`0600`, atomic, removed on a clean shutdown) so the [`terminus` CLI](../cli/README.md)
running on the same machine can authenticate without copying a token. It carries the
same full-access secret as the login link; because the token rotates every boot, a
stale file left by a crash authenticates nothing. See
[docs/security.md](../docs/security.md#the-admin-token-file-for-the-local-cli).

Every port, path, and tuning knob is an environment variable — see
[Configuration](#configuration) for the single table of all of them, their
defaults and scope, and the deprecated `NETCAPTURE_*` aliases.

## Configuration

Every collector and CLI setting is an environment variable. Ports, the state
directory, and the ingest/proxy tuning knobs are read at process start.

| Variable | Default | Scope | Description | Deprecated alias |
| --- | --- | --- | --- | --- |
| `TERMINUS_PORT` | `8787` | collector | Loopback UI / `/api/*` / exports HTTP port. The bare `PORT` spelling is still accepted as legacy. | `NETCAPTURE_PORT` |
| `TERMINUS_INGEST_PORT` | `8788` | collector | WSS device-capture ingest port (`/ingest`, TLS on the LAN). Bare `INGEST_PORT` accepted as legacy. | `NETCAPTURE_INGEST_PORT` |
| `TERMINUS_ATLANTIS_PORT` | `10909` | collector | Atlantis TLS capture ingest port. Bare `ATLANTIS_PORT` accepted as legacy. | `NETCAPTURE_ATLANTIS_PORT` |
| `TERMINUS_CERT_PORT` | `8789` | collector | Public cert endpoint port (`GET /api/cert`, plain HTTP on the LAN) for QR pairing. | `NETCAPTURE_CERT_PORT` |
| `TERMINUS_STATE_DIR` | `~/Library/Application Support/Terminus` (macOS) | collector + cli | Identity/state directory: certificate, private key, device token, and the `admin-token` file. The CLI reads the `admin-token` file from here to authenticate on the same machine. | `NETCAPTURE_STATE_DIR` |
| `TERMINUS_PAIRING_HOST` | first current LAN IPv4 in the certificate SAN | collector | Host advertised in the pairing blob, QR, `terminus pair`, and the cert-endpoint log. Must be an IP (or resolvable name) the certificate SAN already covers; an invalid value is ignored with a one-time warning. | `NETCAPTURE_PAIRING_HOST` |
| `TERMINUS_INGEST_PAUSE_MAX_MS` | `30000` | collector | Max time a back-pressured (read-paused) WSS ingest connection may stay paused before it is closed with `1013` (overload). | `NETCAPTURE_INGEST_PAUSE_MAX_MS` |
| `TERMINUS_ATLANTIS_PING_MS` | `30000` | collector | Interval between server→client Atlantis `ping` control frames on an authenticated connection; `0` disables pinging. | `NETCAPTURE_ATLANTIS_PING_MS` |
| `TERMINUS_BODY_BUDGET` | `67108864` (64 MiB) | collector | Total bytes of captured request/response/frame bodies retained across all devices before the store evicts to make room. A positive integer of bytes, optional binary `k`/`m`/`g` suffix (e.g. `256m`); an invalid value is fatal at start. | `NETCAPTURE_BODY_BUDGET` |
| `TERMINUS_PROXY` | off | collector | `=1` turns on the additive MITM proxy source (off by default). | `NETCAPTURE_PROXY` |
| `TERMINUS_PROXY_PORT` | `8080` | collector | Proxy listener port (when the proxy is on). | `NETCAPTURE_PROXY_PORT` |
| `TERMINUS_PROXY_ALLOW` | empty (rejects every client) | collector | Comma-separated device-IP allowlist for the proxy. An empty allowlist rejects every client, so there is no open relay. | `NETCAPTURE_PROXY_ALLOW` |
| `TERMINUS_ALLOW_LEGACY_LOOPBACK` | off | collector | `=1` opens a plaintext Atlantis listener on `127.0.0.1:10910` (loopback only, testing). | `NETCAPTURE_ALLOW_LEGACY_LOOPBACK` |
| `TERMINUS_LOG_LEVEL` | `info` | collector | Log verbosity (`debug`\|`info`\|`warn`\|`error`); an invalid value falls back to `info` with a warning. Every line carries an ISO-8601 timestamp and the level. | `NETCAPTURE_LOG_LEVEL` |
| `TERMINUS_CRASH_THRESHOLD` | `5` | collector | Number of `uncaughtException`/`unhandledRejection` events within 60 s that trigger a clean shutdown with exit 1 (state lock released, `admin-token` removed). | `NETCAPTURE_CRASH_THRESHOLD` |
| `TERMINUS_HOST` | `127.0.0.1` | cli | Collector host the CLI connects to. In `tail`/`ls`, `--host` is the traffic filter, so the connection host is taken from this variable instead of the flag. | — |
| `TERMINUS_PORT` | `8787` | cli | Collector port the CLI connects to. | — |
| `TERMINUS_TOKEN` | — | cli | Admin bearer token for the CLI. Used after `--token` and before the `admin-token` file fallback. | — |
| `TERMINUS_RECONNECT_MIN_MS` | `1000` | cli | `terminus tail` reconnect backoff floor. Internal, for tests. | — |
| `TERMINUS_RECONNECT_MAX_MS` | `15000` | cli | `terminus tail` reconnect backoff cap. Internal, for tests. | — |
| `TERMINUS_LS_PAGE_SIZE` | `200` | cli | `terminus ls` per-page fetch size. Internal, for tests. | — |
| `TERMINUS_LS_MAX_PAGES` | `50` | cli | `terminus ls` page ceiling for filtered scans. Internal, for tests. | — |

Notes:

- **Deprecated aliases.** Every variable the collector reads through its `env()`
  helper also accepts the deprecated `NETCAPTURE_*` spelling as a fallback, with a
  one-time warning per name. The port variables additionally accept the bare
  legacy spellings (`PORT`, `INGEST_PORT`, `ATLANTIS_PORT`) after both prefixed
  forms, silently. Note that `TERMINUS_PORT` means the UI port for the collector
  and the connection port for the CLI — the same number on one machine. The CLI
  variables are read directly from the environment and have no `NETCAPTURE_*`
  alias (`TERMINUS_STATE_DIR` is the exception — the CLI resolves it through the
  collector's helper, so its alias applies).
- **`TERMINUS_PASSCODE` / `NETCAPTURE_PASSCODE` are no longer used.** The old
  plaintext passcode was sent in the clear and is never reused as a v2 credential.
  If either is set, the collector prints a migration notice; unset it and pair
  devices from the authenticated UI instead.
- **`TERMINUS_PROXY_CA`** is read on the **device / M-agent** side (where to load
  the proxy CA), not by the collector.

## Run as a service (macOS)

To keep the collector running across logins, install it as a per-user launchd agent.
It runs the built `dist/main.js`, so build first:

```sh
npm run build -w collector
collector/scripts/launchd/install.sh
```

`install.sh` renders `scripts/launchd/com.terminus.collector.plist.template` with the
absolute paths of your `node` and this checkout, writes
`~/Library/LaunchAgents/com.terminus.collector.plist`, and bootstraps it under your
GUI session (`launchctl bootstrap gui/$UID`). Logs (stdout and stderr) go to
`~/Library/Logs/Terminus/collector.log`. Check state with
`launchctl print gui/$UID/com.terminus.collector`.

Remove it with `collector/scripts/launchd/uninstall.sh` (the log file is kept). The
agent uses fixed ports; set overrides in the plist's `EnvironmentVariables` if the
defaults collide, then reinstall.

## Migration from argo-netcapture

This collector was previously called **argo-netcapture**. Upgrading in place needs
no manual steps:

- **State dir renamed automatically.** On startup (and on `identity:rotate`) the
  collector renames a leftover `~/Library/Application Support/ArgoNetCapture` to
  `~/Library/Application Support/Terminus` in one move, before taking the state
  lock. Identity, certificate, device token and the proxy CA move together, so
  **already-paired devices stay paired**. If a populated new dir already exists it
  touches neither and warns; an explicit state-dir override opts out of migration —
  `TERMINUS_STATE_DIR`, its deprecated `NETCAPTURE_STATE_DIR` fallback, or the
  `--state-dir` flag on `identity:rotate`. Migration never blocks startup: a
  cross-volume or permission failure is logged and the collector continues with a
  fresh state dir.
- **Env vars deprecated, not removed.** Every `NETCAPTURE_*` variable is still read
  as a fallback for its `TERMINUS_*` replacement, emitting a one-time deprecation
  warning per name. Rename them at your convenience.
- **App build must match the mDNS name.** Discovery now advertises `_terminus._tcp`.
  An Atlantis app build still looking for the old service will not find the
  collector until it declares `_terminus._tcp` in `NSBonjourServices`.
- **Atlantis control-frame marker.** The `ready`/`auth_error` control frame the
  collector sends now carries `buildVersion: "terminus-2"` (was `netcapture-2`).
  Devices do not read this field, so it needs no app change.

## Device identity and pairing

On first run the collector generates a persistent identity in the state dir: a UUID
`collectorId`, an RSA-3072/SHA-256 self-signed `serverAuth` certificate (365-day
validity, SAN covering the host and LAN IPs), and a 32-byte device token. The state
dir is `0700`, the private key and token `0600`, all written atomically. A restart
**preserves** the identity and device token (devices stay paired) while rotating the
admin token (UI sessions must re-login). An unreadable or expired identity is a hard
error — it is never silently regenerated.

The device pairing (certificate digest + device token) is fetched by the
authenticated UI from `GET /api/pairing` (`Cache-Control: no-store`) and pasted into
the QA screen. The response also carries `certPort` (the LAN cert listener's port),
so the UI can render the QR below. The terminal only ever prints the admin token,
never the device token.

### The advertised pairing host is the Mac's LAN IP

The `host` in the pairing blob and QR is **the Mac's LAN IPv4** (e.g. `192.168.1.10`),
resolved at runtime — not the machine hostname. Phones have no way to resolve the
Mac's hostname on the LAN (there is no DNS for it, and Android's `fetch` does not do
mDNS), so a hostname-based pairing fails immediately with a fetch error. The IP is
chosen as the first current LAN IPv4 that is also in the certificate's SAN, so the
device's TLS SAN check passes when it dials it.

Because the address is a **DHCP lease**, it can change. When it does, the old cert no
longer covers the new IP: rotate the identity (which regenerates the cert SAN and the
pairing) and re-pair every device:

```bash
npm run identity:rotate
```

`terminus pair` prints the host it advertises. If no current LAN IPv4 is in the cert
SAN (e.g. after a lease change), the collector logs a warning at boot, `GET
/api/pairing` returns it as `pairingHostWarning`, and `terminus pair` prints it —
pointing you at `identity:rotate`. Rotation is never automatic: it invalidates every
existing pairing.

To pin the advertised host yourself, set **`TERMINUS_PAIRING_HOST`** to a LAN IP (or a
name the devices can actually resolve). It must be an IP the certificate SAN already
covers for the device's SAN check to pass; if it is not, rotate with `--ip <lan-ip>`.

### QR pairing

The Devices screen renders a QR the app can scan instead of pasting the blob. The
certificate DER (~1.4 KB) is too large for a screen-scannable code, so the QR carries
the short identity plus the secret, and the app fetches the DER separately:

- **QR payload** — a compact one-line `QrPairing` JSON: `version`, `collectorId`,
  `host`, `certPort`, `ingestPort`, `atlantisPort`, `certificateSha256` (64 hex) and
  `deviceToken`. It is the full pairing **minus** the DER.
- **`GET /api/cert`** — served by the dedicated LAN cert listener (`8789`, plain
  HTTP), **not** the loopback UI server. Public, `no-store`, returns
  `{ collectorId, certificateDerBase64, certificateSha256 }` and carries **no**
  `deviceToken`. No auth because the certificate is public — presented in the clear
  on every TLS handshake — and it is not the root of trust: the QR is. It lives on
  its own LAN listener so the UI server can stay loopback-only.
- **App-side verification** — the app scans the QR, fetches
  `http://<host>:<certPort>/api/cert`, and refuses to pair unless
  `sha256(DER) === certificateSha256` from the QR **and** the `collectorId` matches.
  Any divergence is a hard `Certificate mismatch, refusing to pair`. Plain HTTP is
  only a transport for the (public) cert; the QR, shown on the trusted collector
  screen, is what pins it.

> **Security note.** The QR **contains the `deviceToken`** — the bearer secret a
> paired device presents on every capture ingest. Treat the Devices screen as a
> secret: anyone who photographs the QR can pair as a device. The pairing code
> rotates only the admin/UI session on restart, not the device token, so a leaked QR
> stays valid until you rotate the identity (`npm run identity:rotate`).

To reissue the identity (new certificate, token and UUID — every device must
re-pair), stop the collector and run:

```bash
npm run identity:rotate -- --host <hostname> --ip <lan-ip>
```

Rotation takes the state-dir lock, so it refuses to run while a collector is up, and
replaces the files atomically.

## Authentication and loopback

- The UI, `/api/*`, exports and the `/ui` socket bind **loopback only**
  (`127.0.0.1:8787`) and validate `Host`/`Origin` against the real port.
- A fresh **admin token** (32 random bytes) is generated on every start. Restart
  invalidates all sessions and the previous token.
- `POST /api/session` with `Authorization: Bearer <adminToken>` returns `204`
  and sets an `HttpOnly; SameSite=Strict; Path=/` cookie (`nc_session`), valid up
  to 12 h with a 30 min idle timeout, at most 16 concurrent sessions.
- `DELETE /api/session` revokes the session and closes its live `/ui` socket.
- Every data/export/clear route requires a session cookie or the admin bearer;
  cookie-driven mutations additionally require an exact `Origin`. A bearer on
  loopback needs no `Origin` (for CLI use). No token is ever accepted in a query
  string. `GET /health` (status + version) and the login-screen static assets are
  the only anonymous surfaces and carry no capture data.

## Ports

| Port    | Bind        | Protocol         | Purpose                                  |
| ------- | ----------- | ---------------- | ---------------------------------------- |
| `8787`  | `127.0.0.1` | HTTP + WS        | Web UI, `/api/*`, exports, `/ui` socket  |
| `8788`  | LAN         | HTTPS + WSS      | Device capture ingest (`/ingest`, TLS)   |
| `8789`  | LAN         | HTTP             | Public cert endpoint (`GET /api/cert`) for QR pairing — see below |
| `10909` | LAN         | TLS              | Atlantis capture ingest                  |
| `8080`  | LAN         | HTTP proxy (MITM)| Proxy source — **off** unless `TERMINUS_PROXY=1`, allowlisted |

There are four always-on listeners (plus the opt-in proxy):

- **UI (`8787`, loopback).** Web UI, `/api/*`, exports and the `/ui` socket, bound to
  `127.0.0.1` with a DNS-rebinding Host check. Unreachable from the LAN by design.
- **Ingest (`8788`, LAN TLS)** and **Atlantis (`10909`, LAN TLS).** The capture
  channels; both require TLS **and** the device token and expose no UI/API route.
- **Cert (`8789`, LAN plain HTTP).** Serves only the public certificate for QR
  pairing (`GET /api/cert`). Plain HTTP is safe here because the certificate is
  public — it is presented in the clear on every TLS handshake — and the QR, not
  this endpoint, is the root of trust: the app verifies the DER's SHA-256 against
  the QR before trusting it. It carries no device token and reads no request body.
  Port via `TERMINUS_CERT_PORT` (default `8789`). It exists as a separate LAN
  listener precisely so the UI server can stay loopback-only: a paired device on the
  LAN could not otherwise reach the cert.

mDNS advertises only
`_terminus._tcp` on the WSS port with TXT `{v:'2', transport:'tls',
collectorId, atlantisPort}` — never the legacy plaintext `_Proxyman._tcp` name.

### Legacy plaintext loopback (opt-in, testing only)

Setting `TERMINUS_ALLOW_LEGACY_LOOPBACK=1` opens a **plaintext** Atlantis listener
on `127.0.0.1:10910` with the historical 64 MiB frame ceiling. It is loopback-only,
never advertised over mDNS, and must not be exposed on the LAN.

## Using Atlantis (iOS/Android)

The Atlantis forks connect over TLS using the imported pairing (certificate + device
token). The device pins the collector's certificate as its sole trust anchor;
hostname/SAN, validity and digest are all checked, and the `ConnectionPackage`
`passcode` field carries the device token. Discovery uses `_terminus._tcp`, and the
Atlantis app build must declare the **same** service in its `NSBonjourServices`:

```xml
<key>NSBonjourServices</key>
<array>
  <string>_terminus._tcp</string>
</array>
```

The collector applies header/query redaction to Atlantis traffic (the in-app
protocol is already redacted at the source). Redaction is never undone.

### Liveness ping

After the `ready` control frame, the collector sends a `ping` control frame on each
authenticated connection every `TERMINUS_ATLANTIS_PING_MS` (default `30000`; set `0`
to disable). The frame carries a `ts`; the timer is per connection and cleared on
close, and a write failure closes the socket. An SDK at or beyond the next fork tag
reads these pings for dead-connection detection (it drops the connection after two
missed pings); the current forks tolerate the unknown control type — iOS ignores it,
the Android fork has no reader yet — so pinging is safe today. If the SDK ever replies
with a `pong` control frame, the collector accepts and ignores it (not counted as
traffic).

### Device channels and identity

A single phone can reach the collector on **two channels**: the in-app WSS
`ingest` channel (which sends `hello { deviceId, … }`) and the Atlantis SDK
`atlantis` channel over TLS (which presents its own envelope id). The collector
keys devices by those ids, so if the two channels use **different** ids the same
phone shows up as two devices and selecting one shows no traffic.

The fix is for the app to **start the Atlantis SDK with the app's own
`deviceId`**, so both channels key on the same id. Do that and the device is one
record from the start.

Two collector-side aids make the split visible and harmless meanwhile:

- **Channels on the record.** Each device DTO (`/api/devices`, the socket
  snapshot's `devices[]`) carries `channels: { ingest?: { lastSeenAt },
  atlantis?: { lastSeenAt } }`; `lastSeen` stays the max across them. The Devices
  view and `terminus devices` show which channels a device has been heard on, and
  the Capture view points you at *All devices* when a selected device is empty.
- **Alias from the hello.** When the app knows the key the SDK will use but cannot
  yet start it with the app's id, the `hello` may carry
  `atlantisDeviceKey: "<the SDK's key>"`. The collector then attributes Atlantis
  traffic arriving under that key to the hello's `deviceId` — one device, both
  channels. The alias lives in memory only; if the SDK key already names a
  distinct device that has captured traffic, both are kept and a warning is logged.

  For the alias to take effect, **start the ingest channel first**: send the
  `hello` (with `atlantisDeviceKey`) before starting the Atlantis SDK, so the alias
  is already known when SDK traffic arrives. If the SDK connects first, its traffic
  is keyed under its own id and a separate, entry-less device record may linger
  until the next UI snapshot (reconnect or resync) reconciles the view. Identity
  metadata is placeholder-safe regardless of order: a real `buildProfile` from the
  hello is never overwritten by the channel placeholders (`unknown`, `atlantis`),
  and an empty SDK `appVersion` never clears a known one.

## Ingest limits and back-pressure

Both capture ingests (WSS and Atlantis TLS) share one bounded scheduler: a
per-connection pending cap of 8 frames, a global cap of 64, two decode slots, and
a shared byte budget (128 MiB) covering framing buffers and queued frames.

When a device's burst outruns those caps, the collector **stops reading that
connection instead of dropping it**. On the WSS ingest a pending-cap overload
pauses the socket (`ws.pause()`) and parks the frames whose bytes are already
reserved — in order, so nothing is lost or reordered — and resumes reading once
the connection drains back below its low-water mark. This is the correct response
to a legitimate reconnect flush (e.g. an app replaying its queue after a collector
restart): the single connection is kept and every frame is ingested in order,
rather than closed with `1013` and made to replay the same burst.

A connection that stays paused too long is the backstop: after
**`TERMINUS_INGEST_PAUSE_MAX_MS`** (default `30000`) a still-stuck connection is
closed with `1013` and counted as an overload, so a peer that keeps its socket
buffer full but never lets the collector catch up cannot pin resources forever. A
**byte-budget** overload (a frame that will not fit the shared cap) is a different
failure and still closes immediately, as does a frame on an already-closed
connection.

The scheduler's stats expose `paused` (connections currently read-paused) and
`pauses` (total pause episodes since boot) alongside the existing `overload`
counter; each pause episode is logged once at info
(`ingest wss: back-pressure on <connId> …` / `… resumed on <connId> after <ms> ms`).

## Proxy source (additive, QA-only, opt-in)

An optional MITM proxy (built on [mockttp](https://github.com/httptoolkit/mockttp),
pinned exact) captures device traffic as a third source, `source: 'proxy'`. It is
**additive**: it never replaces or disables Atlantis/WSS capture, and it never
dedupes — the same request seen by Atlantis and by the proxy is kept as **two**
independent pieces of evidence (the UI has a source filter and an overlap notice).

Enable it with `TERMINUS_PROXY=1`. It is **off** by default and is intended only
for an authorized QA test device.

| Env | Meaning |
|---|---|
| `TERMINUS_PROXY=1` | Turn the proxy listener on (off by default). |
| `TERMINUS_PROXY_PORT` | Proxy port (default `8080`). |
| `TERMINUS_PROXY_ALLOW` | Comma-separated **device IP allowlist**. Empty ⇒ every client is rejected. |

Each `TERMINUS_*` variable also accepts its deprecated `NETCAPTURE_*` spelling as a
fallback, with a one-time warning.

Guarantees enforced by the collector:

- **No open relay.** A client outside the allowlist is rejected at the connection,
  and the cloud-metadata destination `169.254.169.254` is always refused.
- **Separate trust.** The proxy has its **own** CA (private dir `proxy-ca/` under the
  state dir, key `0600`), distinct from the collector's TLS identity. On start the
  cert PEM path is logged; copy it to the QA device and trust it there (the M side
  reads it via `TERMINUS_PROXY_CA`). Removing that trust after QA is manual.
- **Collector endpoints are tunnelled raw.** The collector's own ingest/UI/Atlantis
  endpoints are passed through without interception, so the device keeps pinning the
  collector's real certificate through the proxy and no device token/auth header ever
  enters the proxy store.
- **Same redaction and caps** (1 MiB/body, 256 KiB/WS message) as the other sources,
  applied before the bytes reach the store.

A client may still ignore the proxy, use its own trust store, pin its own
certificate, or use QUIC — the proxy is not total coverage. A refused proxy CA is
recorded as a `tls_error` entry rather than lost.

## Export

- **HAR 1.2** — `GET /export.har?device=<id>` (or the **Export HAR** button).
  Import into Chrome DevTools → Network → right-click → **Import HAR file…**.
- **JSON** — `GET /export.json?device=<id>` (`{ entries, ws }`), or **Export JSON**.

Omit `?device=` to export all devices.

Both exports **stream** from an immutable, point-in-time snapshot that holds the
bodies it will emit under an **export lease** (≤ 30 s). A clear, upsert or capture
that arrives mid-download cannot corrupt the stream, and the snapshot's retained
bytes keep counting against the 64 MiB bodies budget — an export never relaxes a
limit, so a capture arriving while an export is in flight is subject to the same
budget (it is omitted with reason `budget` if there is no room). The lease is
released when the download finishes, when the client disconnects, or after 30 s.

### HAR extensions (terminus, R5)

The exporter never fabricates data it did not capture — no invented
`Content-Length`, success status, or measured timing. What a plain HAR cannot
express is carried in `_`-prefixed extension fields (HAR 1.2 permits custom
members prefixed with `_`; standard importers ignore the ones they do not know):

- **Bodies.** Captured **text** rides `response.content.text` (UTF-8) /
  `request.postData.text`. Captured **binary** response bytes ride
  `response.content` with `encoding: "base64"` and the true `size`. A captured
  **binary request** body is **not** given a fake UTF-8 `postData.text`; its bytes
  go in `request.postData._terminusContent = { text, encoding: "base64", size }`.
  An **omitted** body carries `_terminus = { state: "omitted", reason, size? }`
  (reason ∈ `size | budget | binary | not-captured`; `size` only when the original
  length is known) and no text. An **absent** body (e.g. a GET with no request
  body) carries no `postData`/extension at all — absence is not an omission — while
  an empty captured body keeps an empty `text` so it does not disappear.
- **WebSocket / SSE union.** Captured sockets are exported alongside HTTP. A
  session **linked** to its HTTP handshake (`httpEntryKey`) attaches its messages
  to that entry instead of duplicating the handshake; an **unlinked** session
  becomes a **synthetic** entry, explicitly marked
  (`_terminus.synthetic = true`, `statusUnknown = true`, response status `0`,
  timings `-1`) and is **never** matched to an existing entry by URL. WebSocket
  frames use `_webSocketMessages` (Chrome DevTools' own convention): `type` is
  `send`/`receive`, `time` is in **seconds**, and complete text/binary messages
  get `opcode` 1/2 (binary `data` is base64 with `_terminus.encoding`).
  Ping/pong and unknown opcodes are **not** inferred from the payload. **SSE**
  uses its own `_terminusEventStream` array (no WS opcode), never
  `_webSocketMessages`. The close frame and the retained/dropped/partial frame
  counts live in the entry's `_terminus`.

**Interoperability caveat.** `_webSocketMessages` is Chrome DevTools' own
convention; `_terminusContent`, `_terminusEventStream` and the `_terminus`
markers are terminus-specific. Other HAR consumers ignore unknown `_`-fields —
the visible request/response are still standard HAR 1.2. What has actually been
checked here is **structural HAR 1.2 validity** (a required-field validator over
the sample fixtures, asserted in `test/har-roundtrip.test.ts`); a physical import
into Chrome DevTools → Network is **pending manual trial** and is not claimed as
verified. Do **not** assume any third-party tool renders these extensions until
you have tried it. Sample fixtures live in `test/fixtures/har/`
(`http-bodies.har`, `websocket.har`, `sse.har`) and are regenerated from
`test/fixtures/har/scenarios.ts` by `npx tsx scripts/regen-har-fixtures.ts`; the test
suite diffs them against a fresh export so they cannot silently drift. Use them for
that manual DevTools trial.

## Endpoints

| Method | Path                     | Auth      | Description                              |
| ------ | ------------------------ | --------- | ---------------------------------------- |
| GET    | `/health`                | anonymous | `{ status, version }` liveness           |
| POST   | `/api/session`           | bearer    | Trade admin bearer for a session cookie  |
| DELETE | `/api/session`           | cookie    | Revoke session, close its `/ui` socket   |
| GET    | `/`                      | anonymous | Web UI shell / login screen              |
| GET    | `/api/entries?device=&cursor=&limit=` | session | `Page<EntrySummary>` = `{ items, nextCursor }`. Summaries only — identity + `BodyRef`s (hash + size + omission), never body bytes. `cursor` is the base64url `nextCursor` of the previous page. |
| GET    | `/api/entries/:device/:id` | session | `EntryDetail` — the summary plus request/response headers and `statusText`, still no body bytes. |
| GET    | `/api/entries/:device/:id/body?side=request\|response` | session | One body: `200` with the bytes (empty for an absent body), `410` when omitted, `404` when the record is gone. |
| GET    | `/api/ws?device=&cursor=&limit=` | session | `Page<WsSummary>` — the frame array is replaced by counts; frames page separately. |
| GET    | `/api/ws/:device/:wsId/frames?after=&limit=` | session | `Page<FrameSummary>` — `after` is the last `sequence` seen. |
| GET    | `/api/ws/:device/:wsId/frames/:sequence/body` | session | One frame's payload (same `200`/`410`/`404` contract as an entry body). |
| GET    | `/api/devices?cursor=&limit=` | session | `Page<UiDevice>`                        |
| GET    | `/api/status`            | session   | Operational status: `{ version, uptimeMs, paused, devices, retention, bodies, ingest }` — aggregate counters only, no capture payload. `ingest` is the ingest scheduler's `WorkStats` (or `null`). |
| POST   | `/api/clear?device=`     | session   | Clear one device (or all); needs Origin  |
| POST   | `/api/pause`             | session   | Pause/resume the live `/ui` stream. Body `{ "paused": true\|false }` (≤1 KiB, else `413`; non-boolean/malformed → `400`) → `200 { "paused": bool }`. Cookie mutation needs Origin. While paused the store keeps recording; resume replays a fresh snapshot. |
| GET    | `/api/pairing`           | session   | `PairingImport` + `certPort` for the QA screen / QR (no-store) |
| GET    | `/export.har?device=`    | session   | HAR 1.2 download                         |
| GET    | `/export.json?device=`   | session   | Raw JSON download                        |
| WS     | `/ui`                    | session   | Live UI stream: an initial `snapshot` (carries `paused`, protocol v3) then incremental deltas, including `{ type: 'paused', paused }` on toggle. |

Pause is a property of the collector, not of a browser tab: once paused the stream
stays paused across client disconnects and reconnects until it is explicitly resumed
or the collector process restarts.

Device capture ingest (`/ingest`) lives on the separate TLS listener (`8788`), not on
this loopback server. The public QR-pairing cert endpoint (`GET /api/cert`) lives on
its own plain-HTTP LAN listener (`8789`), also not on this loopback server.

## Limitations

- Loopback only; not meant to be exposed to the internet or the LAN.
- Redaction at the collector applies to **Atlantis** and **proxy** traffic (the
  in-app WSS protocol is redacted at the source).
- The proxy is not total coverage: a client may ignore it, use its own trust store,
  pin its own certificate, or use QUIC. It never disables Atlantis/WSS.
- In-memory store: data is lost on restart, and old entries are dropped past the
  5 000-per-device cap.
- **Resumed WebSocket sessions.** A socket the device holds open across a
  collector restart sends frames whose `ws_open` the new collector never saw. The
  store **synthesizes** a session for the first such frame (rather than dropping
  it): the session is marked `resumed`, its `url` is `null`, and `openedAt` is the
  first frame's timestamp — everything before the restart is lost, so the prefix
  is missing by definition. When the device later replays its `ws_open` (with a
  `resumed` flag), the collector fills in the `url` **in place** and clears the
  `resumed` mark; it never opens a duplicate session or resets the captured
  frames. The Sockets view shows a **resumed** chip and `URL unknown (opened
  before the collector started)` until the url is back-filled; the CLI prints
  `ws:? (resumed)` for a frame whose session has no url yet. An orphan frame that
  carries no device id (so no session can be attributed) is still dropped and
  logged once per socket at `warn`.

## Troubleshooting

Certificate mismatches, an unreachable LAN IP, `EADDRINUSE`, a stale `admin-token`,
missing OpenSSL, QR pairing on a hardened QA build, and `terminus tail` reconnect
behaviour are covered in [docs/troubleshooting.md](../docs/troubleshooting.md).

## Development

```bash
npm test          # vitest
npm run typecheck
npm run dev       # initial UI build + watch; backend via `tsx watch src/main.ts`
npm run start:built  # run the last compiled build without rebuilding
```

`npm run dev` builds the UI once, then watches: the Svelte UI rebuilds through
`vite build --watch`, and the backend runs under `tsx watch`, which restarts it
(rebinding the listeners) on any `src/` change. UI and backend build errors are
printed and don't kill the session. Ctrl-C stops the watchers and the backend
together, freeing ports `8787`/`8788`/`10909`.

### Browser UI (Svelte 5)

The loopback UI is a Svelte 5 single-page app under `ui/`, built by Vite to
`dist-ui/` and served by the collector on the loopback listener.

```bash
npm run dev           # build the UI once, then watch (vite build --watch) + tsx watch backend
npm run test:ui       # component/unit tests (vitest, jsdom + @testing-library/svelte)
npm run test:browser  # build dist-ui, then the Playwright end-to-end suite (headless chromium)
npm run lint:ui       # eslint over ui/src
npm run check:ui      # svelte-check
npm run ui:build      # one-off production UI build → dist-ui/
```

Build artifacts (`npm run build` or `npm run ui:build`): `dist-ui/app.js`,
`dist-ui/app.css`, `dist-ui/index.html` (plus `dist-ui/fonts/`). The combined
gzipped `app.js` + `app.css` has a size budget of ≤ 150 KB.

**Reactivity policy:** `$effect` / `$effect.pre` / `$effect.root` and the legacy
`$:` are forbidden anywhere in `ui/src` — derivations use `$derived`, and side
effects live in `{@attach}` lifecycles or explicit event handlers. The rule is
enforced by ESLint (`npm run lint:ui`) and by `ui/src/__tests__/no-effect.test.ts`,
which fails CI if any source reintroduces them.

The Playwright specs (`test/browser/`) drive a real in-process collector via
`createCollectorHarness` and serve the built `dist-ui`; run one file with
`npx playwright test test/browser/<name>.spec.ts`. The screenshot suite
(`test/browser/screenshots.spec.ts`) is skipped unless `SHOTS=1` is set, and writes
1440×900 validation PNGs to `../docs/screenshots/` for visual comparison.
