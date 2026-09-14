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
an `Origin`, when present, must be a loopback page on that same port. Cookie-driven
mutations (`DELETE /api/session`, `POST /api/clear`, `POST /api/pause`)
additionally require an exact matching `Origin`. The `/ui` WebSocket, which
bypasses same-origin protections, repeats the session and exact-`Origin` check on
its upgrade. A mismatched `Host` is answered `421`, a bad `Origin` `403`.

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

Redaction runs during normalization, before any bytes are stored or hashed, and
is never undone. It masks auth-bearing headers (`authorization`, `cookie`,
`set-cookie`, `access-token`, `client`, `uid`), sensitive URL query parameters
(`access_token`, `client_id`, `uid`), and matching keys inside text/JSON bodies.
It applies to Atlantis and proxy traffic; the in-app WSS protocol is already
redacted at the source. Redaction reduces, but does not eliminate, the sensitivity
of a capture: application payloads are still recorded, so a capture or an export
should be handled as potentially sensitive.

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
collector's machine to the **original host**, reusing the request's **captured
credentials** — the `authorization`/`cookie` headers as they were sent, plus any
overrides the caller supplies. This is a deliberate outbound request, distinct from
passive capture:

- **It leaves the machine.** Unlike everything else the collector does (loopback UI,
  LAN-only ingest), a replay makes a real outbound request to the target host. It
  follows no redirects and times out at 30 s.
- **It reuses captured auth.** The stored request headers are replayed verbatim
  (only hop-by-hop and `host`/`content-length` are stripped and recomputed), so the
  captured session token/cookie is sent again. Replaying a state-changing request
  (POST/PUT/DELETE) repeats its side effect. Only replay what you intend to re-issue.
- **It is authenticated and same-origin.** The route needs the same session-or-bearer
  auth as every `/api/*` route, and a cookie-driven call needs a valid loopback
  Origin (a bearer CLI does not) — so a web page cannot drive a replay via CSRF.
- **The result is a new record.** The response is stored as a fresh entry with
  `source: replay` and a `replayOf` back-reference; the original is untouched.

## Residual risks

- Capture data lives in memory unencrypted for the life of the process; anyone
  with access to the machine or a memory dump can read it.
- Exports are plain files with real (redacted) traffic; protect them accordingly.
- The device token does not rotate on restart; rotate the identity to revoke a
  leaked token or QR.
- Redaction is keyword-based; a secret carried under an unrecognized field name is
  not masked.

## Reporting

To report a vulnerability, see [SECURITY.md](../SECURITY.md) in the repository
root.
