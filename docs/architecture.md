# Architecture

Terminus is a local Mac collector that captures HTTP and WebSocket/SSE traffic
from devices on the LAN, keeps it in memory, shows it in a loopback web UI, and
exports it as HAR 1.2 or JSON. This document describes the listeners, the path a
captured request takes from the wire to the dashboard, the two pairing flows, the
on-disk state, and the optional MITM proxy. For the trust model behind these
choices, see [security.md](security.md).

## Listeners and ports

The collector opens four always-on listeners, plus two opt-in ones. Only the UI
listener is on loopback; the capture channels bind the LAN so devices can reach
them.

| Port    | Bind        | Protocol          | Purpose                                                       |
| ------- | ----------- | ----------------- | ------------------------------------------------------------ |
| `8787`  | `127.0.0.1` | HTTP + WS         | Web UI, `/api/*`, exports, and the `/ui` live socket         |
| `8788`  | `0.0.0.0`   | HTTPS + WSS       | Device capture ingest (`/ingest`), TLS + device token        |
| `8789`  | `0.0.0.0`   | HTTP              | Public cert endpoint (`GET /api/cert`) for QR pairing        |
| `10909` | `0.0.0.0`   | TLS               | Atlantis capture ingest                                      |
| `8080`  | `0.0.0.0`   | HTTP proxy (MITM) | Optional proxy source — off unless `TERMINUS_PROXY=1`         |
| `10910` | `127.0.0.1` | plaintext         | Optional legacy Atlantis loopback — off unless opted in      |

Ports are overridable through the environment: `PORT`, `INGEST_PORT`,
`ATLANTIS_PORT`, and `TERMINUS_CERT_PORT` (each `TERMINUS_*` variable also accepts
a deprecated `NETCAPTURE_*` spelling with a one-time warning). Every listener is
additive: a bind failure on the cert listener or the proxy is logged and never
takes the capture channels down.

The collector advertises only the TLS ingest over mDNS as `_terminus._tcp` on the
WSS port. The TXT record carries non-secret coordinates (`v=2`, `transport=tls`,
`collectorId`, `atlantisPort`) and never the certificate or device token. The
legacy plaintext `_Proxyman._tcp` name is never published.

## Capture flow: ingest to dashboard

A captured exchange flows through the same five stages regardless of which source
produced it:

1. **Ingest.** One of three sources accepts bytes from a device:
   - **Own protocol over WSS** (`8788`, `/ingest`): the in-app instrumentation.
     Each device message is a JSON frame bounded to 2 MiB by the socket; the
     aggregate pending queue is bounded by a shared 128 MiB byte budget, and at
     most 16 device connections are served across both TLS channels.
   - **Atlantis over TLS** (`10909`): the Atlantis iOS/Android forks. The
     device's `ConnectionPackage` carries the device token as its `passcode`; the
     collector answers with a `ready` (or `auth_error`) control frame before
     replay begins.
   - **Proxy** (`8080`, optional): a MITM proxy that observes device traffic as a
     third source. See "Optional proxy" below.

2. **Normalization.** Each source has its own decoder that turns wire bytes into
   the collector's internal shape: `src/atlantis/decode.ts` for Atlantis,
   `src/proxy/normalize.ts` for the proxy, and the WSS/JS path in `src/store.ts`.
   Normalization classifies each body as text, binary, oversize (omitted), or
   absent, decoding each body exactly once.

3. **Redaction.** During normalization, `src/redactor.ts` masks sensitive
   material **before** any bytes are stored or hashed. It redacts auth-bearing
   request/response headers (`authorization`, `cookie`, `set-cookie`,
   `access-token`, `client`, `uid`), sensitive URL query parameters
   (`access_token`, `client_id`, `uid`), and matching keys embedded in text/JSON
   bodies (for example an ActionCable subscribe frame). Binary bodies are not
   treated as text. Redaction is never undone.

4. **Store.** `src/store.ts` is an in-memory store with bounded retention on
   every axis: at most 5000 HTTP entries per device, a 64 MiB body budget with a
   1 MiB per-body cap (256 KiB per WebSocket message), and a 32 MiB metadata
   budget. Bodies live in a content-addressed `BodyStore` keyed by the SHA-256 of
   their already-redacted bytes, so identical payloads are stored once. Nothing
   is persisted; all capture data is lost on restart.

5. **Broadcast to the dashboard.** `src/uiBroadcast.ts` owns the `/ui`
   WebSocket. On connect it sends an initial `snapshot`, then fans out
   incremental deltas under a shared serialization and per-socket/session/global
   byte caps. Pause is a property of the collector, not of a browser tab: once
   paused the store keeps recording but the stream stops until resume replays a
   fresh snapshot. The dashboard is a Svelte 5 single-page app under
   `collector/ui/`, built to `dist-ui/` and served from the loopback listener.
   Screenshots of the dashboard live in [screenshots/](screenshots/).

The UI reads only metadata and body **references** through `/api/*`; body bytes
are fetched lazily per record. Exports (`/export.har`, `/export.json`) stream
from an immutable, point-in-time snapshot that holds the bodies it will emit
under a lease (≤ 30 s), so a concurrent clear or capture cannot corrupt an
in-flight download and the export never bypasses the body budget.

## Pairing

A device must trust the collector's certificate and hold its device token before
it can ingest. Both are delivered by pairing, which comes in two forms that end
at the same import path.

- **Paste.** The authenticated UI fetches the pairing blob from
  `GET /api/pairing` (`Cache-Control: no-store`): the collector's certificate
  (DER), certificate SHA-256, LAN coordinates, and the device token. The operator
  copies it into the device's QA screen. The terminal only ever prints the admin
  token, never the device token.

- **QR.** The certificate DER (~1.4 KB) is too large for a screen-scannable code,
  so the QR carries the short identity plus the secret — `version`, `collectorId`,
  `host`, `certPort`, `ingestPort`, `atlantisPort`, `certificateSha256`, and
  `deviceToken` — and the device fetches the DER separately from the public
  `GET /api/cert` endpoint on the cert listener (`8789`). The device refuses to
  pair unless `sha256(DER)` equals the `certificateSha256` from the QR **and** the
  `collectorId` matches. The QR, shown on the trusted collector screen, is the
  root of trust; the plain-HTTP cert fetch is only a transport for public bytes.

## State directory and migration

On first run the collector generates a persistent identity in its state directory
(`~/Library/Application Support/Terminus`, overridable with `TERMINUS_STATE_DIR`):
a UUID `collectorId`, an RSA-3072/SHA-256 self-signed `serverAuth` certificate
(365-day validity, SAN covering the host and LAN IPs), and a 32-byte device token.
The directory is `0700`, the private key and token `0600`, and all files are
written atomically (temp file then rename) so a crash never leaves a half-written
identity that would be trusted on the next boot. A running collector holds an
exclusive `state.lock`, so `identity:rotate` refuses to run while a collector is
up; a lock left by a dead process is reclaimed as stale.

A restart **preserves** the identity and device token, so paired devices stay
paired, while rotating the admin token, so UI sessions must re-login. An
unreadable, expired, or mismatched (key/cert) identity is a hard, actionable
error — it is never silently regenerated, which would break every paired device.

The collector was previously named **argo-netcapture**. On startup, before the
lock is taken, it renames a leftover `~/Library/Application Support/ArgoNetCapture`
directory to the new location in a single move, so identity, certificate, device
token, and proxy CA migrate together and already-paired devices stay paired. If a
populated new directory already exists it touches neither and warns; an explicit
state-dir override opts out. Migration never blocks boot: a cross-volume or
permission failure is logged and the collector continues with a fresh state dir.

## Optional proxy

An optional MITM proxy (built on `mockttp`) captures device traffic as a third
source (`source: 'proxy'`). It is **off** by default and enabled with
`TERMINUS_PROXY=1` for an authorized QA test device. It is strictly additive: it
never replaces or disables the WSS/Atlantis capture, and it never dedupes — the
same request seen by two sources is kept as two independent pieces of evidence.

The proxy has its own CA under the state directory (`proxy-ca/`), separate from
the collector's TLS identity. The collector's own ingest/UI/Atlantis endpoints
are tunnelled through without interception, so a device keeps pinning the
collector's real certificate and no device token or auth header ever enters the
proxy store. A client IP allowlist is required (`TERMINUS_PROXY_ALLOW`): an empty
allowlist rejects every client, so there is no open relay on the LAN, and the
cloud-metadata address `169.254.169.254` is always refused. Proxy traffic passes
through the same redaction and body caps as the other sources.

The proxy is not total coverage: a client may ignore it, use its own trust store,
pin its own certificate, or use QUIC. It never disables the app-side capture.
