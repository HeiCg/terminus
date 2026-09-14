# Ingest protocol (instrument your own app)

This document describes the wire protocol a device app speaks to the Terminus
collector's **own** capture channel — the authenticated WSS ingest — so you can
instrument an app **without** the Atlantis SDK. It is the contract the collector
enforces; the in-app JavaScript instrumentation shipped with Terminus is one
client of it, and any client that follows the same rules is captured identically.

For the Atlantis fork channel, see [Using Atlantis](../collector/README.md#using-atlantis-iosandroid);
for the trust model, see [security.md](security.md); for the listeners, see
[architecture.md](architecture.md).

## 1. Overview

The collector exposes two LAN capture channels, both TLS with device-token auth:

- **Own protocol** over WSS at `wss://<host>:8788/ingest` — the channel this
  document covers. A single WebSocket carries a stream of JSON **device
  messages**: one `hello`, then request/response and WebSocket events.
- **Atlantis** over TLS on port `10909` — the Proxyman/Atlantis wire protocol,
  spoken by the existing iOS/Android forks. See section 6.

To instrument your own app you open the WSS channel, authenticate with the device
token from pairing, wait for the server's `ready` control frame, then push a
`hello` followed by one JSON message per captured HTTP exchange or WebSocket
event. The collector holds everything in memory and shows it in the loopback UI.

The UI, `/api/*` and exports are **not** on this channel — they live on the
loopback HTTP listener (`127.0.0.1:8787`) and are never reachable from the LAN.

## 2. Discovery and pairing

Before a device can connect it must pair once, obtaining three things: the
collector's LAN **host**, its **certificate** (to pin), and the **device token**
(the bearer secret). Pairing is delivered as a QR shown on the trusted collector
screen (or the pasted pairing blob).

### QR payload (`QrPairing`)

The QR is a compact one-line JSON object with these fields:

| Field                | Type                | Meaning                                        |
| -------------------- | ------------------- | ---------------------------------------------- |
| `version`            | `2`                 | Pairing format version.                        |
| `collectorId`        | UUID string         | Stable collector identity (never an IP).       |
| `host`               | string              | The collector's LAN IPv4 (or a name/IP you can dial). |
| `certPort`           | number              | Port of the plain-HTTP cert endpoint (default `8789`). |
| `ingestPort`         | number              | WSS ingest port (default `8788`).              |
| `atlantisPort`       | number              | Atlantis TLS port (default `10909`).           |
| `certificateSha256`  | 64 lowercase hex    | SHA-256 of the certificate **DER**.            |
| `deviceToken`        | string              | The bearer secret presented on every ingest.   |

The QR carries everything **except** the certificate DER itself (too large for a
scannable code). The DER is fetched separately.

### `GET /api/cert` (fetch the certificate)

Fetch the DER from the dedicated LAN cert listener — **not** the loopback UI
server:

```
GET http://<host>:<certPort>/api/cert
```

It is plain HTTP, unauthenticated, `Cache-Control: no-store`, and returns:

```json
{
  "collectorId": "…",
  "certificateDerBase64": "…",
  "certificateSha256": "…"
}
```

The response carries **no** device token. Plain HTTP is safe here because the
certificate is public (it is presented in the clear on every TLS handshake) and
because the endpoint is **not** the root of trust — the QR is.

### Verify and pin

The app must, before trusting the certificate:

1. base64-decode `certificateDerBase64` to the DER bytes;
2. compute `sha256(DER)` and require it to equal `certificateSha256` **from the
   QR** (not from the `/api/cert` response);
3. require the `collectorId` from `/api/cert` to equal the QR's `collectorId`.

Any divergence is a hard failure — refuse to pair. Once verified, **pin** that
certificate as the sole TLS trust anchor for the ingest and Atlantis channels
(there is no public CA in the path).

### mDNS

The collector advertises the TLS ingest over mDNS as **`_terminus._tcp`** on the
WSS port. The TXT record carries only non-secret coordinates —
`v=2`, `transport=tls`, `collectorId`, `atlantisPort` — and never the certificate
or the device token, which are paired out of band. An app that uses mDNS to find
the collector must declare `_terminus._tcp` in its service list (e.g.
`NSBonjourServices` on Apple platforms). Note that Android's `fetch` does not
resolve mDNS names, which is why the advertised pairing `host` is a LAN IPv4.

## 3. Connection

Open a WebSocket to:

```
wss://<host>:8788/ingest
```

- **Path** must be exactly `/ingest`; any other path is refused with `404` before
  the WebSocket handshake.
- **Auth** is a bearer token on the HTTP upgrade request:
  `Authorization: Bearer <deviceToken>`. The collector verifies it with a
  constant-time compare **before** the handshake. A wrong or absent token is
  refused with `401 Unauthorized` (a real HTTP status line, not a dead socket);
  an over-capacity collector answers `503 Too Many Connections` (at most 16
  device connections across both LAN channels).
- **TLS** must validate against the **pinned** certificate. Because the host is a
  LAN IPv4 present in the certificate SAN, a standard SAN/identity check passes.
  The collector requires TLS 1.2 or higher.

On a successful upgrade the collector sends exactly one control frame as its first
message:

```json
{ "type": "ready", "protocolVersion": 2 }
```

Capture may begin once `ready` is received. There is **no** post-auth idle
timeout: an authenticated, idle connection is never torn down for silence (TCP
keepalive is enabled so a vanished Wi-Fi peer is still noticed).

## 4. Messages

After `ready`, the client sends newline-free JSON text frames, one **device
message** per frame. Each message has a `type`. A single frame is bounded to
**2 MiB** by the transport; a frame that fails to parse as JSON, or that is not a
recognized device message, is counted as invalid, and **too many invalid frames**
close the connection with code `1008`.

`ts` fields are epoch **milliseconds**. Ordering rule: the **first** message on a
connection must be a `hello` — any request/response/WebSocket event that arrives
before a `hello` has been seen is rejected (the connection has no device id to
attribute it to yet).

### `hello`

Announces the device. Must be first.

```json
{
  "type": "hello",
  "deviceId": "pixel-8",
  "platform": "android",
  "appVersion": "1.4.2",
  "buildProfile": "debug",
  "dropped": 0,
  "ts": 1726300000000,
  "atlantisDeviceKey": "optional-sdk-key"
}
```

| Field               | Req? | Type                  | Notes                                                        |
| ------------------- | ---- | --------------------- | ------------------------------------------------------------ |
| `type`              | yes  | `"hello"`             |                                                              |
| `deviceId`          | yes  | string                | The stable id this device is keyed under.                    |
| `platform`          | yes  | `"android"`\|`"ios"`  |                                                              |
| `appVersion`        | yes  | string                |                                                              |
| `buildProfile`      | yes  | string                | e.g. `"debug"`, `"release"`.                                 |
| `dropped`           | yes  | number                | Count of events the client dropped locally before sending.   |
| `ts`                | yes  | number                | Epoch ms.                                                    |
| `atlantisDeviceKey` | no   | string                | The key the Atlantis SDK will present under, if known, so the collector can attribute Atlantis traffic to this same `deviceId`. Send the `hello` **before** starting the Atlantis SDK for the alias to take effect. |

### `request`

One captured HTTP request.

```json
{
  "type": "request",
  "id": "req-42",
  "ts": 1726300000100,
  "method": "POST",
  "url": "https://api.example.com/v1/login",
  "headers": { "content-type": "application/json" },
  "body": "{\"user\":\"a\"}",
  "bodySize": 12,
  "source": "xhr"
}
```

| Field         | Req? | Type                    | Notes                                                                |
| ------------- | ---- | ----------------------- | -------------------------------------------------------------------- |
| `type`        | yes  | `"request"`             |                                                                      |
| `id`          | yes  | string                  | Correlates this request with its `response` (same `id`).             |
| `ts`          | yes  | number                  | Epoch ms.                                                            |
| `method`      | yes  | string                  |                                                                      |
| `url`         | yes  | string                  |                                                                      |
| `headers`     | —    | object of string→string | Sent already redacted (see below).                                   |
| `body`        | —    | string \| null          | UTF-8 text body, or `null` when omitted/absent.                      |
| `bodyOmitted` | no   | `"size"` \| `"binary"`  | Present when the body was dropped: too large (`size`) or non-text (`binary`). |
| `bodySize`    | yes  | number                  | Original body length in bytes.                                       |
| `source`      | —    | `"xhr"`                 | This channel's source tag.                                           |

The collector validates `id`, `ts`, `method`, `url`, `bodySize`; the remaining
fields are read when present. Send a full object (as above) for a complete record.

### `response`

The response for an earlier `request`, matched by `id`.

```json
{
  "type": "response",
  "id": "req-42",
  "ts": 1726300000260,
  "status": 200,
  "statusText": "OK",
  "headers": { "content-type": "application/json" },
  "body": "{\"ok\":true}",
  "bodySize": 11,
  "durationMs": 160
}
```

| Field         | Req? | Type                                  | Notes                                            |
| ------------- | ---- | ------------------------------------- | ------------------------------------------------ |
| `type`        | yes  | `"response"`                          |                                                  |
| `id`          | yes  | string                                | Same `id` as the request.                        |
| `ts`          | yes  | number                                | Epoch ms.                                        |
| `status`      | yes  | number                                | HTTP status code.                                |
| `statusText`  | —    | string                                |                                                  |
| `headers`     | —    | object of string→string               |                                                  |
| `body`        | —    | string \| null                        | UTF-8 text body, or `null`.                      |
| `bodyOmitted` | no   | `"size"` \| `"binary"`                | Why the body is not carried, if omitted.         |
| `bodySize`    | yes  | number                                | Original body length in bytes.                   |
| `durationMs`  | yes  | number                                | Request→response duration.                       |
| `error`       | no   | `"network"`\|`"timeout"`\|`"abort"`   | Set when the request failed instead of returning a normal response. |

### `ws_open`

Opens a captured WebSocket session.

```json
{
  "type": "ws_open",
  "wsId": "ws-7",
  "ts": 1726300001000,
  "url": "wss://api.example.com/stream",
  "protocols": [],
  "resumed": false
}
```

| Field       | Req? | Type      | Notes                                                                                          |
| ----------- | ---- | --------- | ---------------------------------------------------------------------------------------------- |
| `type`      | yes  | `"ws_open"` |                                                                                              |
| `wsId`      | yes  | string    | Session id; frames and the close reference it.                                                 |
| `ts`        | yes  | number    | Epoch ms.                                                                                      |
| `url`       | yes  | string    |                                                                                                |
| `protocols` | —    | string[]  | Negotiated subprotocols.                                                                        |
| `resumed`   | no   | boolean   | Set `true` when replaying a `ws_open` for a socket still open across a collector restart. The collector treats a resumed `ws_open` for a known session as a back-fill/no-op — never a duplicate open or a new session. Omit it (older clients do) for a normal open. |

### `ws_frame`

One WebSocket frame.

```json
{
  "type": "ws_frame",
  "wsId": "ws-7",
  "ts": 1726300001500,
  "direction": "out",
  "data": "ping",
  "size": 4,
  "binary": false
}
```

| Field       | Req? | Type              | Notes                                                       |
| ----------- | ---- | ----------------- | ----------------------------------------------------------- |
| `type`      | yes  | `"ws_frame"`      |                                                             |
| `wsId`      | yes  | string            | The session this frame belongs to.                          |
| `ts`        | yes  | number            | Epoch ms.                                                   |
| `direction` | yes  | `"in"`\|`"out"`   | `in` = received by the app, `out` = sent by the app.        |
| `data`      | —    | string \| null    | UTF-8 text for a text frame; `null` for a binary frame.     |
| `size`      | yes  | number            | Frame payload size in bytes.                                |
| `binary`    | —    | boolean           | `true` for a binary frame (its bytes are not carried as text). |

### `ws_close`

Closes a session.

```json
{
  "type": "ws_close",
  "wsId": "ws-7",
  "ts": 1726300002000,
  "code": 1000,
  "reason": "done"
}
```

| Field    | Req? | Type          | Notes                       |
| -------- | ---- | ------------- | --------------------------- |
| `type`   | yes  | `"ws_close"`  |                             |
| `wsId`   | yes  | string        |                             |
| `ts`     | yes  | number        | Epoch ms.                   |
| `code`   | yes  | number        | WebSocket close code.       |
| `reason` | —    | string        | Close reason text.          |

### Bodies, sizes, and redaction

- **Text bodies** ride `body`/`data` as UTF-8 strings. **Binary bodies** are not
  carried on this channel: mark them with `bodyOmitted: "binary"` (HTTP) or
  `binary: true` and `data: null` (WebSocket). This channel does not define a
  base64 body field — send text or omit.
- `bodySize`/`size` always carry the **original** byte length even when the body
  itself is omitted, so the UI can show how large the dropped body was.
- A body too large to send should be set to `null` with `bodyOmitted: "size"`.
- **Redaction is the client's job on this channel.** The collector applies its own
  redaction to Atlantis and proxy traffic, but treats the in-app WSS protocol as
  **already redacted at the source** — it does not re-scrub what you send. Strip
  auth-bearing headers, query parameters, and body fields **before** sending.

## 5. Back-pressure and reconnection

The collector protects itself with a bounded scheduler shared across both capture
channels: a per-connection pending cap of **8** frames, a global cap of **64**,
**2** decode slots, and a shared **byte budget** of 128 MiB covering framing
buffers and queued frames. A single device message is additionally capped at
2 MiB by the transport.

When a client's burst outruns the pending caps, the collector **stops reading the
connection instead of closing it** — it pauses the socket and parks the frames it
has already reserved, in order, then resumes reading once it has drained back
below its low-water mark. This is the correct handling of a legitimate reconnect
flush (an app replaying its queue after the collector restarted): the connection
is kept and every frame is ingested in order.

What a client should do:

- **Treat a pause as normal, not an error.** If the collector goes quiet mid-burst
  it is draining; keep the socket open and keep the send buffer bounded on your
  side. Do not tear down and reconnect on back-pressure — that just replays the
  same burst.
- **Handle the close codes.** The collector closes with:
  - `1013` — overload. Emitted when a paused connection stays stuck past
    **`TERMINUS_INGEST_PAUSE_MAX_MS`** (default `30000` ms), when a frame will not
    fit the shared byte budget, or when a frame arrives on an already-closing
    connection. Back off, then reconnect and resume from where you left off.
  - `1008` — too many invalid frames (malformed JSON or non-device messages). Fix
    the client; reconnecting without fixing it will close again.
- **Reconnect with backoff.** On any drop, reconnect with exponential backoff and
  jitter (e.g. 1s, 2s, 4s … capped, then a random 50–100% of the delay) so a fleet
  of clients does not reconnect in lockstep.
- **Re-`hello`, then resume.** A new connection always starts with a fresh `hello`.
  For a WebSocket still open across the reconnect, replay its `ws_open` with
  `resumed: true` so the collector back-fills the session rather than opening a
  duplicate.
- **Report local drops.** If you dropped events while disconnected, reflect the
  count in the next `hello`'s `dropped` field.

## 6. Atlantis channel (pointer)

The Atlantis fork channel is a **separate** protocol and is not covered here in
detail. In brief: it is TLS on port **`10909`**, speaks the Proxyman/Atlantis wire
protocol, and authenticates by carrying `passcode=<deviceToken>` in the device's
`ConnectionPackage`. On a token match the collector replies with a `ready` control
frame (or `auth_error` and closes) and then decodes Atlantis traffic frames. On an
authenticated connection the collector also sends a periodic `ping` control frame
(interval `TERMINUS_ATLANTIS_PING_MS`, default `30000` ms, `0` disables) for
dead-connection detection. If you are instrumenting your own app, prefer the WSS
ingest above; the Atlantis channel exists for the existing SDK forks. See
[Using Atlantis](../collector/README.md#using-atlantis-iosandroid).

## 7. Minimal Node example

A self-contained client that pins the collector's certificate, authenticates,
waits for `ready`, and sends a `hello` plus one request/response pair. It uses the
[`ws`](https://github.com/websockets/ws) library and a pinned `https.Agent`. This
is illustrative (it is not run in CI), but it is a correct use of the protocol.

```js
import WebSocket from 'ws';
import https from 'node:https';
import { createHash } from 'node:crypto';

// From pairing (the QR / pasted blob):
const HOST = '192.168.1.10';
const INGEST_PORT = 8788;
const CERT_PORT = 8789;
const DEVICE_TOKEN = '<deviceToken-from-pairing>';
const EXPECTED_SHA256 = '<certificateSha256-from-QR>'; // 64 lowercase hex

// 1. Fetch and pin the certificate DER from the public cert endpoint.
async function fetchPinnedCert() {
  const body = await new Promise((resolve, reject) => {
    https.get(
      // The cert endpoint is plain HTTP; use http here in a real client.
      { host: HOST, port: CERT_PORT, path: '/api/cert', protocol: 'http:' },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve(buf));
      },
    ).on('error', reject);
  });
  const { certificateDerBase64 } = JSON.parse(body);
  const der = Buffer.from(certificateDerBase64, 'base64');
  const sha = createHash('sha256').update(der).digest('hex');
  if (sha !== EXPECTED_SHA256) throw new Error('certificate mismatch, refusing to pair');
  // Wrap the DER as PEM so it can be used as a CA anchor.
  const pem =
    '-----BEGIN CERTIFICATE-----\n' +
    der.toString('base64').replace(/(.{64})/g, '$1\n') +
    '\n-----END CERTIFICATE-----\n';
  return pem;
}

async function main() {
  const ca = await fetchPinnedCert();

  // 2. Open the WSS ingest, pinning the cert and presenting the device token.
  const ws = new WebSocket(`wss://${HOST}:${INGEST_PORT}/ingest`, {
    headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    agent: new https.Agent({ ca }), // trust ONLY the pinned certificate
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString('utf8'));
    if (msg.type !== 'ready') return;

    // 3. hello must be first.
    ws.send(JSON.stringify({
      type: 'hello', deviceId: 'my-app', platform: 'android',
      appVersion: '1.0.0', buildProfile: 'debug', dropped: 0, ts: Date.now(),
    }));

    // 4. one request + its response (correlated by id). Redact before sending.
    const id = 'req-1';
    ws.send(JSON.stringify({
      type: 'request', id, ts: Date.now(), method: 'GET',
      url: 'https://api.example.com/ping', headers: {},
      body: null, bodySize: 0, source: 'xhr',
    }));
    ws.send(JSON.stringify({
      type: 'response', id, ts: Date.now(), status: 200, statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}', bodySize: 11, durationMs: 12,
    }));

    ws.close(1000, 'done');
  });

  ws.on('close', (code, reason) => {
    console.log('closed', code, reason.toString());
  });
  ws.on('error', (e) => console.error('ingest error', e));
}

main().catch((e) => { console.error(e); process.exit(1); });
```
