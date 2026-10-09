# Security model

Terminus captures real device traffic, including request and response bodies, and
holds it in memory. This document states what it defends against, the mechanism
behind each defense, and the residual risks a user should understand. For how the
pieces fit together, see [architecture.md](architecture.md).

## Threat model in brief

Terminus is a developer tool for a trusted LAN, not an internet-facing service. It
assumes:

- The **loopback interface** and the machine running the collector are trusted.
- The **LAN is semi-trusted**: other hosts can send packets to the capture
  listeners, so those must authenticate every device and must never expose the UI
  or any capture data to the network.
- A **person with physical sight of the collector screen** is trusted enough to
  pair a device (the pairing QR is shown there on purpose).

The primary assets to protect are the captured traffic (which may contain
secrets), the device token (which authorizes ingest), and the collector's private
key.

## The UI is loopback-only, with a Host check

The web UI, `/api/*`, exports, and the `/ui` socket bind `127.0.0.1:8787` only —
never the LAN. On top of the bind, every request is checked with a DNS-rebinding
defense: the `Host` header must be a loopback name on the real listening port, and
an `Origin`, when present, must be a loopback page on that same port. Every
state-changing route goes through one gate (`requireMutation`): a cookie/session
caller must present an exact matching `Origin` (the CSRF defense), while a bearer
CLI caller — which has no ambient cookie to forge — is exempt. This covers
`POST /api/clear`, `POST /api/pause`, `POST /api/replay`, and `DELETE /api/session`;
the session-delete route is cookie-only, so it always requires an `Origin`. The
`/ui` WebSocket, which bypasses same-origin protections, repeats the session and
exact-`Origin` check on its upgrade. A mismatched `Host` is answered `421`, a bad
`Origin` `403`.

The result: a malicious web page the operator visits cannot script the collector
through DNS rebinding, and a device on the LAN cannot reach the UI at all.

## The admin token is ephemeral

A fresh 32-byte admin token is generated on every start and printed once, in the
terminal, in the URL fragment (`http://127.0.0.1:8787/#token=<adminToken>`). The
browser trades that fragment for an `HttpOnly; SameSite=Strict` session cookie via
`POST /api/session` and strips the fragment before any request, so no token
reaches browser storage, logs, or a query string. Sessions are in-memory, valid up
to 12 hours with a 30-minute idle timeout, at most 16 at once. Because the token
is regenerated each start and sessions are in-memory, a restart invalidates every
outstanding session and old login link while leaving device pairing intact. A CLI
may present the admin token directly as a `Bearer` (no `Origin` needed, for
loopback automation); a token is never accepted in a query string.

`GET /health` (status and version) and the login-screen static assets are the only
anonymous surfaces on the loopback server, and neither carries capture data.

### The admin-token file (for the local CLI)

So the `terminus` CLI can authenticate without the operator copying a token, the
collector writes the current admin token to `admin-token` in the state directory
(`~/Library/Application Support/Terminus/admin-token` on macOS; see the platform
paths above, or `TERMINUS_STATE_DIR`). It is written `0600`, beside the other
`0600` secrets, with an atomic create-exclusive temp file and a rename, and is
**removed on a clean shutdown**. It carries the same secret the login link embeds,
so it grants full local access — anyone who can read it can already read the
private key in the same directory. Because the token is regenerated every boot, a
**stale file left by a crash is harmless**: it no longer matches the running
collector, so it authenticates nothing until overwritten by the next boot. The CLI
uses it only as the last fallback, after `--token` and `TERMINUS_TOKEN`.

### The reader token (for local automation)

Beside the admin token the collector writes a second per-boot bearer, the **reader
token**, to `reader-token` in the same state directory. It is generated, written
(`0600`, atomic), rotated on restart and removed on shutdown exactly like the admin
token; only its scope differs. It is the recommended credential for a local
automation client (a test runner, a script, an agent) that only needs to read
captured traffic. The CLI accepts it in `TERMINUS_TOKEN` (or `--token`) for its
read-only commands `status`, `ls`, `show` and `devices`, and those commands read the
`reader-token` file themselves when `admin-token` is absent.

The HTTP gate resolves every credential to a role. The session cookie and the admin
bearer are `admin`; the reader bearer is `reader`, which passes an explicit
allowlist: `GET` on `/health`, `/api/status`, `/api/devices`, `/api/entries` and its
sub-routes (detail, body, `wait`), and `/api/ws` and its sub-routes. Everything
else, including any route added later until it is listed, answers
`403 {"error":"forbidden_scope","required":"admin"}`. The full route contract is in
[read-api.md](read-api.md#authentication).

Threat model. A local process holding the reader token:

- **can** read all captured traffic the collector still holds, including request
  and response bodies and WebSocket frames, as stored: already redacted, but with
  every application payload intact;
- **cannot** obtain the device token or the pairing blob (`/api/pairing` is
  admin-only), so it cannot pair a device or ingest traffic;
- **cannot** change state: no clear, pause, replay, export download, or session;
- **cannot** open the `/ui` live socket.

Like the admin-token file, the reader-token file is readable only by the user that
runs the collector, and that user can already read the admin token and the private
key in the same directory. The reader token narrows what a well-behaved automation
client can do by accident; it is not a boundary against a hostile process running
as the same user.

## Devices authenticate with a pinned certificate and a device token

Both LAN capture channels (`8788` WSS and `10909` Atlantis TLS) require **two**
independent facts: a TLS handshake against the collector's certificate, and the
32-byte device token. Neither is accepted on the loopback UI listener.

- **Certificate pinning.** The device trusts the collector's self-signed
  certificate as its sole anchor — hostname/SAN, validity, and digest are all
  checked. There is no public CA in the path.
- **Device token.** On the WSS channel the device presents the token as a
  `Bearer` on the upgrade, verified with a constant-time compare **before** the
  WebSocket handshake, so a wrong or absent token sees a real `401` and never
  reaches ingest. On the Atlantis channel the token rides the `ConnectionPackage`
  `passcode` field. The token is 32 random bytes, persisted `0600`, and survives
  restarts so paired devices stay paired.

The old plaintext passcode that earlier versions sent in the clear is never reused
as a credential; if the corresponding environment variable is set, the collector
warns and points the operator at the pairing flow.

## `GET /api/cert` is public, and the QR is the root of trust

QR pairing needs the device to fetch the collector's certificate DER, which is too
large for a screen-scannable code. The collector serves it from a dedicated
plain-HTTP LAN listener (`8789`, `GET /api/cert`) with **no** authentication.

This is safe because:

- The certificate is **already public** — it is presented in the clear on every
  TLS handshake — so serving it over plain HTTP discloses nothing new. The
  response carries the certificate and its digest, and **no** device token.
- The endpoint is **not** the root of trust. The QR shown on the trusted
  collector screen is. The device verifies `sha256(DER) === certificateSha256`
  from the QR and that the `collectorId` matches before it will pair; any
  divergence is a hard `Certificate mismatch, refusing to pair`. A tampered or
  substituted cert served over plain HTTP is therefore rejected.

The cert listener lives on its own LAN port precisely so the UI server can stay
loopback-only: a paired device on the LAN could not otherwise reach the cert. It
reads no request body, disables keep-alive, and caps concurrent sockets with short
timeouts to bound the blast radius of an unauthenticated listener.

> **The QR contains the device token.** Anyone who photographs the QR can pair as
> a device. Treat the Devices screen as a secret. A restart rotates only the admin
> session, not the device token, so a leaked QR stays valid until the identity is
> rotated (`npm run identity:rotate`).

## Auth material is redacted before storage

Redaction runs at the collector during normalization, before any bytes are stored
or hashed, and is never undone. It applies to every source: Atlantis, the in-app
WSS ingest, the proxy, and the stored result of a replay. A masked value is
replaced by `***`.

**What is masked.** One matcher decides whether a name is a credential, for header
names, URL query parameter names (case-insensitive) and body keys. It matches by
**word**, not by substring: the name is split on camelCase, `_`, `-`, `.`, spaces
and letter/digit boundaries, lowercased, and is sensitive when

- a word (or its plural with one trailing `s`) is one of `password`, `passwd`,
  `pwd`, `secret`, `token`, `apikey`, `auth`, `authorization`, `session`,
  `sessionid`, `credential`, `credentials`, `otp`, `pin`, `cvv`, `cvc`,
  `signature`, `sig`, `cookie`;
- a word is a squashed form `apikey`, `accesstoken`, `sessionid`, `setcookie`;
- two adjacent words are `api` + `key` or `card` + `number`;
- or it is on the pre-0.2 lists, kept so nothing masked before stops being masked:
  headers `access-token`, `client`, `uid`; query `access_token`, `client_id`, `uid`;
  body keys ending in `access_token`, `access-token`, `accesstoken`, `client`,
  `authorization`, `uid` or `password`.

So `X-Session-Id`, `nextPageToken`, `api_key` and `cardNumber` are masked, while
`shipping`, `discard` and `author` are not. Bodies are walked by structure: a JSON
body (by `Content-Type`, or one that starts with `{` or `[`) has the value of every
sensitive key masked at any depth, including inside arrays; a
`application/x-www-form-urlencoded` body has every sensitive parameter masked; and
every text body then gets a pattern pass for `key: "value"`, `"key":"value"` and
`key='value'`, which also reaches JSON embedded in a JSON string. Text WebSocket
frames get the same treatment (JSON is recognised by its leading `{` or `[`).

**Tuning.** Two comma-separated environment variables, read at start and matched
as whole names, case-insensitively:

- `TERMINUS_REDACT_EXTRA` adds names to mask (for example a custom
  `X-Tenant-Key` header your app uses as a credential).
- `TERMINUS_REDACT_ALLOW` exempts names (for example `nextPageToken`, if you need
  pagination tokens in clear). It wins over `TERMINUS_REDACT_EXTRA` and the built-in
  rules, and it also exempts the name from the replay credential strip's shared
  check.

`authorization`, `cookie`, `set-cookie` and `proxy-authorization` can never be
exempted.

**The `redacted` marker.** Every entry carries `redacted: { request, response }`,
set when a value on that side was actually masked (request: URL query, request
headers and body; response: response headers and body). It is shown in the read
API, the HAR export (`_terminus.redacted`) and the JSON export, so a reader can tell
a masked capture from a clean one without searching for `***`. See
[read-api.md](read-api.md#the-redacted-marker).

### What redaction does not cover

- **Binary bodies and binary WebSocket frames** are stored as captured; they are
  never parsed as text.
- **Unrecognised names pass.** A secret under a name none of the rules (or
  `TERMINUS_REDACT_EXTRA`) match is stored in clear, and so is a secret that is not
  the value of a named field at all (a token inside free text or a path segment).
- **Application payloads are recorded.** Redaction reduces, but does not
  eliminate, the sensitivity of a capture, so a capture or an export should be
  handled as potentially sensitive.

## What the MITM proxy implies

The optional proxy (`TERMINUS_PROXY=1`, off by default) is a true man-in-the-middle
for the QA device that trusts its CA. Turning it on means:

- **A separate CA must be trusted on the QA device.** The proxy uses its own CA
  under the state directory, distinct from the collector's TLS identity. Its
  certificate must be installed as a user CA on the test device, and **removing
  that trust after QA is manual**. A device that trusts this CA can have its TLS
  intercepted by whatever holds the CA key.
- **No open relay.** A client outside the required IP allowlist is rejected at the
  connection; an empty allowlist rejects everyone. The cloud-metadata address
  `169.254.169.254` is always refused.
- **Collector endpoints are never intercepted.** The collector's own
  ingest/UI/Atlantis endpoints are tunnelled raw, so the device keeps pinning the
  collector's real certificate and no device token or auth header enters the proxy
  store.
- **Coverage is partial.** A client may ignore the proxy, pin its own certificate,
  use its own trust store, or use QUIC. The proxy never disables the app-side
  capture, and a refused proxy CA is recorded as a `tls_error` entry rather than
  silently lost.

## Replay re-sends captured requests

`POST /api/replay` (and `terminus replay`) re-sends a captured request from the
collector's machine to the **original host**. This is a deliberate outbound request,
distinct from passive capture:

- **It leaves the machine.** Unlike everything else the collector does (loopback UI,
  LAN-only ingest), a replay makes a real outbound request to the target host. It
  follows no redirects and times out at 30 s.
- **Credentials are removed by default.** The request body's `credentials` field
  defaults to `'strip'`: before the request leaves, the collector drops the
  `authorization`, `cookie`, `proxy-authorization`, `x-api-key`, `x-auth-token`
  headers and any `x-*` header naming a token/secret/key/auth, plus the
  credential-bearing query params (`token`, `access_token`, `api_key`, `apikey`,
  `key`, `auth`, `signature`, `sig`, and the same `x-*` pattern), and every header or
  query name the redaction matcher (below) flags. The names removed come back as
  `stripped`. Pass `credentials: 'keep'` (CLI `--with-credentials`, or the UI's
  "Include captured credentials" toggle) to re-send them as stored. Values that
  redaction already masked at capture were stored as `***`, so `keep` re-sends
  `***` for those. Headers the caller supplies explicitly via `overrides.headers`
  are never stripped (the caller chose them), unless the value is the captured one
  repeated verbatim: an editor that sends the whole prefilled header map back still
  gets the captured credentials stripped.
- **Hop-by-hop headers are always recomputed.** `host`/`content-length` and RFC 7230
  hop-by-hop headers are stripped and recomputed regardless of the `credentials`
  choice.
- **Bodies are re-sent as bytes.** Without an override the captured request body,
  text or binary, is re-sent exactly as stored (a text body as stored means after
  capture-time redaction). `overrides.bodyBase64` sends arbitrary bytes; an override
  body is capped at the 1 MiB per-body limit (`413` above it). A body that was not
  retained is never guessed at: the replay is refused `422` until one is supplied.
- **It still repeats side effects.** Even with credentials stripped, replaying a
  state-changing request (POST/PUT/DELETE) re-issues it against the target and repeats
  its side effect. Only replay what you intend to re-issue.
- **It is authenticated and same-origin.** The route goes through the shared mutation
  gate: the same session-or-bearer auth as every `/api/*` route, and a cookie-driven
  call needs a valid loopback Origin (a bearer CLI does not) — so a web page cannot
  drive a replay via CSRF. In the UI, opting into credentials requires a confirming
  second click before the request is sent.
- **The result is a new record.** The response is stored as a fresh entry with
  `source: replay` and a `replayOf: { id, credentials, stripped }` back-reference; the
  original is untouched.
- **The stored result is redacted.** The replay entry goes through the same
  redaction as captured traffic, on both sides (URL, headers, text bodies), and
  carries the `redacted` marker. This applies only to what is stored: the request
  that leaves the machine carries exactly what the `credentials` mode decided, so an
  override body or header is sent as given and stored masked. Binary content (a
  binary `Content-Type`, a NUL byte, or invalid UTF-8) is stored verbatim and is
  not scanned, like any other binary body.

## Residual risks

- Capture data lives in memory unencrypted for the life of the process; anyone
  with access to the machine or a memory dump can read it.
- Exports are plain files with real (redacted) traffic; protect them accordingly.
- The device token does not rotate on restart; rotate the identity to revoke a
  leaked token or QR.
- Redaction is name-based; a secret carried under an unrecognized field name, or in
  a binary body or frame, is not masked (see
  [What redaction does not cover](#what-redaction-does-not-cover)).
- The reader-token file grants read access to all captured traffic; it is protected
  only by file permissions, like the admin-token file.

## Reporting

To report a vulnerability, see [SECURITY.md](../SECURITY.md) in the repository
root.
