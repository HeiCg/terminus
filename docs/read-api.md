# Read API (automation clients)

This document is the HTTP contract a local automation client uses to read what the
collector captured: take a cursor before an action, wait for the request that the
action caused, and inspect it. It covers authentication, versioning, every read
route, the long-poll wait, a recommended client flow, and the limits of what the
collector can know. It describes `apiVersion` 1.

For the trust model behind the tokens and redaction, see [security.md](security.md);
for how capture flows through the collector, see [architecture.md](architecture.md);
for the device-side wire protocols, see [ingest-protocol.md](ingest-protocol.md).

## Overview

The API is JSON over HTTP on the collector's loopback listener,
`http://127.0.0.1:8787` by default (`TERMINUS_PORT`). It is never reachable from
the LAN. Every request must carry a loopback `Host` header (`127.0.0.1` or
`localhost`) on the real listening port, or it is answered `421 misdirected`
(the DNS-rebinding defense). An `Origin` header is optional, but when present it must be a
loopback page on the same port, otherwise the answer is `403 bad origin`.

The examples below assume a reader token in `$TOKEN` (see
[Authentication](#authentication)) and the default port.

## Authentication

Every `/api/*` route and both exports need a credential. `GET /health` is the only
anonymous JSON route.

| Credential | Where it comes from | What it may do |
| --- | --- | --- |
| Admin token | `<stateDir>/admin-token`, and the startup URL `http://127.0.0.1:8787/#token=<adminToken>` | Everything: reads, exports, pairing, clear, pause, replay, the `/ui` live socket, and minting a UI session cookie |
| Reader token | `<stateDir>/reader-token` | `GET` reads only (the reader scope below) |

Both tokens are 32 random bytes (base64url), regenerated on **every** collector
start, written `0600` with an atomic rename, and removed on a clean shutdown. After
a restart the old tokens authenticate nothing: re-read the file. `<stateDir>` is:

| Platform | State directory |
| --- | --- |
| macOS | `~/Library/Application Support/Terminus` |
| Linux | `$XDG_STATE_HOME/terminus` (fallback `~/.local/state/terminus`) |
| Windows | `%LOCALAPPDATA%\Terminus` |

`TERMINUS_STATE_DIR` overrides all of them. Use the reader token for automation;
it is the credential [security.md](security.md#the-reader-token-for-local-automation)
recommends, and it cannot change collector state.

Send the token as a bearer header. A token is never accepted in a query string,
and a bearer caller needs no `Origin`.

```bash
TOKEN="$(cat "$HOME/Library/Application Support/Terminus/reader-token")"
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/status
```

### Reader scope

The reader token is accepted for `GET` on exactly these paths, and nothing else:

- `/health`
- `/api/status`
- `/api/devices`
- `/api/entries` and every sub-route (detail, body, `wait`)
- `/api/ws` and every sub-route (frames, frame body)

Any other request made with the reader token, including a non-`GET` method on one
of the `/api/*` paths above, is refused with:

```
HTTP/1.1 403 Forbidden
Content-Type: application/json

{"error":"forbidden_scope","required":"admin"}
```

That covers `/api/pairing`, `/api/session`, `/api/clear`, `/api/pause`,
`/api/replay`, `/export.har`, `/export.json`, and any route added in a later
version until it is explicitly opened to readers. The `/ui` WebSocket upgrade is
admin-only as well: it first requires a loopback `Origin` (without one the socket
is closed for every caller), and with one a reader gets the same `403` body.

### 401

A missing, malformed, or unknown bearer on any authenticated route is answered
`401` with an empty body. The usual cause is a token from before a collector
restart.

## Versioning and feature detection

`GET /health` needs no credential and returns:

```json
{"status":"ok","version":"0.2.0","apiVersion":1,
 "capabilities":["seq","reader-token","device-identity","filters","wait","redaction-marker"]}
```

```bash
curl -s http://127.0.0.1:8787/health
```

`version` is the collector package version. `apiVersion` is the version of this
read contract. `capabilities` lists the features this collector serves; the same
two fields also appear on `GET /api/status`.

| Capability | What it guarantees |
| --- | --- |
| `seq` | The server sequence: `seq`, `firstSeq` and `receivedAt` on every entry summary; `GET /api/entries` with `afterSeq` or `last`; `epoch`, `gap`, `newOnly`, the `409 stale_cursor` answer; `epoch`, `lastSeq` and `now` on `GET /api/status`. |
| `reader-token` | The `reader-token` file and the reader scope above. |
| `device-identity` | `bundleId`, `appName`, `deviceName`, `model`, `externalId`, `ambiguous` and `startEvents` on devices; the `device` (alias-resolving), `externalId` and `bundleId` scope filters on entries and devices; the `devices` echo; `GET /api/pairing?host=`. |
| `filters` | The `method`, `urlContains`, `status`, `source` and `completed` filters on `afterSeq` and `last` reads. |
| `wait` | `GET /api/entries/wait`. |
| `redaction-marker` | The `redacted` field on entry summaries, details and exports. |

To feature-detect, call `GET /health` once at startup. A collector older than
0.2.0 answers without `apiVersion` and `capabilities` and has none of the features
above. Otherwise require `apiVersion` 1 and check that every capability you rely
on is listed. New fields may be added to any response, and new capabilities to the
list, so ignore what you do not recognise.

## `GET /api/status`

Operational status and where the server sequence stands. Aggregate numbers only,
no capture payload.

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/status
```

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | string | Collector version. |
| `uptimeMs` | number | Time since the HTTP server started. |
| `paused` | boolean | Whether the live UI stream is paused. Pause affects only the `/ui` socket; the store, every read below and `wait` keep working. |
| `devices` | number | Device connections currently open across the WSS and Atlantis channels. |
| `retention` | object | Retained bytes and cumulative drop counters (`droppedEntries`, `evictedForBodyBudget`, ...). |
| `bodies` | object | Body store stats (`retainedBytes`, `blobCount`, `references`). |
| `ingest` | object or null | Ingest scheduler stats. |
| `epoch` | string | Identifies this store instance (16 random bytes, base64url). It changes on every restart. |
| `lastSeq` | number | The newest assigned `seq`; `0` before the first entry write. |
| `now` | number | Collector clock, epoch ms. Same base as `receivedAt`. |
| `apiVersion` | number | As on `/health`. |
| `capabilities` | string[] | As on `/health`. |

## `GET /api/devices`

The device records, as `{ "items": [Device...], "nextCursor": string | null }`,
sorted by `deviceId`. `limit` lowers the page size (non-positive values are
ignored); `cursor` is the previous page's `nextCursor`. The
[device-scope filters](#device-scope) `device`, `externalId` and `bundleId` restrict
the list to the devices they select; a filter that selects nothing gives an empty
`items`, not an error.

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8787/api/devices?bundleId=com.acme.app"
```

A field that no channel has supplied is absent, not `null`.

| Field | Type | Meaning |
| --- | --- | --- |
| `deviceId` | string | The canonical id entries are stored under. For the WSS channel it is the `hello`'s `deviceId`; for Atlantis the envelope id (unless aliased onto a `hello`'s id, see [Limitations](#limitations)); for the proxy `proxy:<session>:<client>`. |
| `platform` | string | `android` or `ios` (from the `hello`, or inferred from an Atlantis `device.model` containing `(Android`); `proxy` for proxy clients. |
| `appVersion` | string | From the `hello`, or the Atlantis `appVersion` (falling back to the project name). |
| `buildProfile` | string | From the `hello`; `atlantis` and `proxy` are placeholders a real value replaces. |
| `dropped` | number | Events the app reported dropping locally (`hello`). |
| `lastSeen` | number | Epoch ms, the latest touch on any channel. A `hello` carries the device clock; Atlantis and proxy touches use the collector clock. |
| `channels` | object | `{ ingest?: { lastSeenAt }, atlantis?: { lastSeenAt } }`, the channels this device was heard on. |
| `bundleId` | string | Atlantis `project.bundleIdentifier` or `hello.bundleId`. |
| `appName` | string | Atlantis `project.name`. |
| `deviceName` | string | Atlantis `device.name` or `hello.deviceName`. |
| `model` | string | Atlantis `device.model` or `hello.model`. |
| `externalId` | string | Atlantis `device.externalId` or `hello.externalId`: an id the automation side knows the device by (simulator UDID, adb serial such as `emulator-5554`, device UDID). |
| `ambiguous` | `true` | Two Atlantis TLS connections open at the same time announced this device's envelope id, so its traffic may mix two apps or devices. Set until `/api/clear` covers the device while no overlap is live (a clear during a live overlap keeps it). A phone that reconnects before its old socket is noticed dead (network switch, app back from background) overlaps briefly and is also flagged. |
| `startEvents` | `true` | This device has sent a request-start event (an Atlantis request-start packet or a WSS `request`), so `firstSeq` marks the start of its exchanges. Never lowered. See [When an entry reaches the collector](#when-an-entry-reaches-the-collector). |

Identity strings are trimmed; a value that is blank, not a string, or longer than
256 characters is dropped, never truncated. A later touch without a value never
erases a known one.

## `GET /api/entries`

HTTP exchanges, as summaries without headers or bodies. The route has three modes,
chosen by the query:

| Mode | Query | Order | Envelope |
| --- | --- | --- | --- |
| Legacy cursor | neither `afterSeq` nor `last` (optional `cursor`, `limit`) | `startedAt`, then `deviceId`, then `id`, ascending | `{ items, nextCursor }` |
| After a sequence | `afterSeq=<n>` | `seq` ascending | `SeqPage` |
| Most recent | `last=<n>` | `seq` ascending | `SeqPage` |

### Legacy cursor mode

`GET /api/entries?cursor=<nextCursor>&limit=<n>` pages through entries ordered by
`startedAt`, the time on the source's clock. It is kept for the UI and the CLI.
Automation should not use it to find "what happened after X": an entry whose
`startedAt` is earlier than the cursor (a late arrival, or a device clock behind
the collector's) lands before the cursor and is never returned. The entry filters
are refused in this mode (`400 filters require afterSeq or last`); the device-scope
filters are accepted.

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8787/api/entries?limit=50"
```

### `afterSeq` mode

`GET /api/entries?afterSeq=<n>` returns the entries whose current `seq` is greater
than `n`, in ascending `seq`.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8787/api/entries?afterSeq=42&epoch=$EPOCH&newOnly=true&method=POST"
```

```json
{"items":[EntrySummary...],"nextSeq":57,"lastSeq":61,"epoch":"q3l...","now":1791136000000,
 "gap":false,"hasMore":false}
```

| Field | Meaning |
| --- | --- |
| `items` | Matching entries, ascending `seq`. Each entry appears at most once, at its current `seq`. |
| `nextSeq` | The `seq` of the last item, or the `afterSeq` you sent when `items` is empty. Use it as the next `afterSeq`. |
| `lastSeq` | The newest `seq` in the store. |
| `epoch` | This store instance. |
| `now` | Collector clock, epoch ms. |
| `gap` | `true` when an entry with a `seq` above your cursor was evicted by retention or removed by a clear, in the scope you asked for. You may have missed records. |
| `hasMore` | `true` only when a further matching entry did not fit in this page. Read again from `nextSeq`. |
| `devices` | Present only when the query named `externalId` or `bundleId`: the sorted `deviceId`s that scope resolved to, possibly `[]`. |

Parameters, all optional except `afterSeq`:

| Parameter | Accepted values |
| --- | --- |
| `afterSeq` | A non-negative integer, at most `lastSeq`. `0` reads from the beginning. |
| `epoch` | The `epoch` your cursor belongs to. Always send it. |
| `limit` | A positive integer; lowers the page cap (values above 200 act as 200). |
| `newOnly` | `true` or `false` (default). `true` keeps only entries with `firstSeq > afterSeq`. |
| `device`, `externalId`, `bundleId` | [Device scope](#device-scope). |
| `method`, `urlContains`, `status`, `source`, `completed` | [Filters](#filters). |

### `last` mode

`GET /api/entries?last=<n>` returns the `n` (1 to 200) most recent entries by `seq`
that match the scope and filters, in ascending `seq`, with the same envelope. There
is no cursor, so `gap` and `hasMore` are always `false`, and `nextSeq` is the `seq`
of the newest item (or `lastSeq` when nothing matched). `newOnly`, `limit` and
`afterSeq` cannot be combined with `last`.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8787/api/entries?last=5&bundleId=com.acme.app&status=5xx"
```

### `EntrySummary`

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Entry id, unique within its device. Atlantis traffic id, WSS `request.id`, `proxy:<session>:<request>`, or `replay-<hex>`. |
| `deviceId` | string | Canonical device id (aliases already resolved). `(deviceId, id)` is the entry's identity and your dedupe key. |
| `source` | string | `atlantis`, `xhr` (the WSS ingest), `proxy`, or `replay`. |
| `startedAt` | number | Epoch ms on the **source's clock**: the device clock for `atlantis` and `xhr`; the collector clock for `proxy` and `replay`. Do not compare it with `receivedAt` or `now` without allowing for skew. |
| `method` | string | Request method. |
| `url` | string | Request URL as stored, after redaction (a masked query value reads `***`). |
| `status` | number or null | Response status; `null` while in flight or when the exchange failed. |
| `durationMs` | number or null | As reported by the source: Atlantis `endAt - startAt` (device clock), the WSS `response.durationMs`, the proxy's own timing, or the collector's timing for a replay. |
| `error` | string or null | Transport failure: Atlantis `"<code> <message>"`, WSS `network`/`timeout`/`abort`, proxy `aborted ...`, replay `network`/`timeout`. |
| `requestBody`, `responseBody` | BodyRef | `{ state, sha256, size, storedSize, encoding, omitted }`. `state` is `absent`, `captured` or `omitted`; `omitted` gives the reason (`size`, `binary`, `budget`, `not-captured`). Bytes come from the body route. |
| `seq` | number | Server sequence of the entry's latest write. |
| `firstSeq` | number | Server sequence of the entry's first write. Never changes. |
| `receivedAt` | number | Collector clock (epoch ms) at the first write. Never changes. |
| `redacted` | object | `{ request: boolean, response: boolean }`, see [The `redacted` marker](#the-redacted-marker). |

An exchange counts as **completed** when it has a `status` or an `error`.

### `seq` and `firstSeq`

The collector keeps one counter per store. Every write of an HTTP entry (its
creation, a response patch, an upsert of the same id) takes the next value, so
`seq` orders entries by when the collector last changed them, independent of any
device clock. An entry's first write fixes `firstSeq` and `receivedAt`; later writes
move only `seq`.

So an entry can come back in a later read with a higher `seq` and the same
`firstSeq`. The rule for a client holding a cursor:

- `firstSeq > cursor`: the entry is new since the cursor.
- otherwise: it is an update of an entry that existed at the cursor (for example
  its response arrived). Merge it by `(deviceId, id)`.

`newOnly=true` applies that rule on the server and drops the updates.

### `gap`

The store is bounded (5 000 entries per device, a shared body budget, a metadata
budget) and `/api/clear` removes records. The collector remembers the highest `seq`
it removed, globally and per device. `gap` is `true` when that value is above your
cursor: something you have not read is gone. A `seq` superseded by a later write of
the same entry is not a removal and never sets `gap`. For a device-scoped read the
per-device value is used (`true` if any device in the scope has one).

### `epoch` and `409 stale_cursor`

The store lives in memory. A restart creates a new `epoch`, restarts `seq` at `0`,
and loses every entry. A cursor from another epoch means nothing, so a seq read or
a wait answers:

```
HTTP/1.1 409 Conflict
Content-Type: application/json

{"error":"stale_cursor","epoch":"<current epoch>","lastSeq":<current lastSeq>}
```

when the `epoch` parameter differs from the current one, or when `afterSeq` is
greater than `lastSeq`. Without the `epoch` parameter, a stale cursor that happens to
be below the new `lastSeq` is accepted and returns unrelated entries, which is why
a client must always send `epoch`.

After a `409` (or a `401`, which a restart also causes because the tokens change):
re-read the token file, take the new `epoch` and `lastSeq` (from the `409` body or
`GET /api/status`), and start again from there. Entries captured before the restart
are gone.

### Device scope

Three optional filters select devices. They apply to all three modes of
`/api/entries`, to `/api/entries/wait`, and to `/api/devices`. An empty value is
treated as absent; filters given together intersect.

| Parameter | Selects |
| --- | --- |
| `device=<id>` | One device. An Atlantis alias key resolves to its canonical device. |
| `externalId=<id>` | Every device record whose `externalId` equals the value. |
| `bundleId=<id>` | Every device record whose `bundleId` equals the value. |

Matching is exact and case-sensitive. A scope that selects no device returns no
entries (and `devices: []` when `externalId` or `bundleId` was given), not an
error. Proxy device records carry no identity fields, so `externalId` and
`bundleId` never select them.

### Filters

Available with `afterSeq`, `last` and `wait` only. Each parameter may be given once;
an empty, repeated or malformed value is `400`, never a filter that matches
everything. They AND together, with the device scope, and with `newOnly`.

| Parameter | Accepted syntax | Matches |
| --- | --- | --- |
| `method` | A method name or a comma list (`POST`, `GET,POST`), case-insensitive, each an RFC 9110 token | `method` in the list |
| `urlContains` | 1 to 512 characters | Case-insensitive substring of the stored (redacted) `url` |
| `status` | A code `201`, a class `2xx` (case-insensitive), or an inclusive range `200-299`; codes are `100` to `599` | `status` in range. An entry without a status never matches. |
| `source` | `xhr`, `atlantis`, `proxy`, `replay` | `source` equal |
| `completed` | `true` or `false` | `true`: has a `status` or an `error`. `false`: has neither (in flight). |

### Page caps

A seq page holds at most 200 entries or 1 MiB of serialized items, whichever comes
first (at least one item is always returned). A legacy cursor page has the same
caps. `limit` only lowers them.

### Errors

| Status | Body | When |
| --- | --- | --- |
| `400` | `{"error":"bad_request","message":"..."}` | A malformed parameter; `afterSeq` or `last` combined with `cursor`; `last` combined with `afterSeq`, `limit` or `newOnly`; a filter without `afterSeq` or `last`. |
| `401` | empty | No valid credential. |
| `403` | `{"error":"forbidden_scope","required":"admin"}` | Reader token outside its scope. |
| `409` | `{"error":"stale_cursor","epoch":"...","lastSeq":n}` | Foreign `epoch`, or `afterSeq` above `lastSeq`. |

## Entry detail and bodies

`GET /api/entries/<deviceId>/<id>` returns the `EntryDetail`: the summary plus
`requestHeaders`, `responseHeaders` (both already redacted) and `statusText`. Use the
canonical `deviceId` from a summary (this route does not resolve aliases) and
percent-encode both segments. Unknown entry: `404`.

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8787/api/entries/com.acme.app-Pixel/req-42"
```

`GET /api/entries/<deviceId>/<id>/body?side=request|response` (default `response`)
returns one body:

- `200` with the stored bytes, `Content-Type: text/plain; charset=utf-8` for text or
  `application/octet-stream` for binary; an empty body when there was none.
- `410` with `{"omitted":"<reason>","size":<n>}` and an `x-body-omitted` header when
  the body was not retained.
- `404` when the entry does not exist (any more).

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8787/api/entries/com.acme.app-Pixel/req-42/body?side=request"
```

### WebSocket captures

WebSocket and server-sent-event sessions are stored apart from HTTP entries and have
**no `seq`**: they cannot be read with `afterSeq`, `last` or `wait`. (The Atlantis
handshake of a WebSocket is also stored as an HTTP entry, which does get a `seq`;
its frames do not.) The routes keep the legacy paging:

- `GET /api/ws?device=&cursor=&limit=`: `{ items: [WsSummary...], nextCursor }`,
  ordered by `openedAt`. `device` is a raw device id here (no alias resolution, no
  `externalId`/`bundleId`). A `WsSummary` carries `wsId`, `deviceId`, `source`,
  `url`, `openedAt`, `kind` (`websocket` or `sse`), `httpEntryKey`, `partial`,
  `resumed`, `closedAt`, `closeCode`, `closeReason` and the frame counts
  `retainedFrames`, `totalFrames`, `droppedFrames`.
- `GET /api/ws/<deviceId>/<wsId>/frames?after=&limit=`: `{ items: [FrameSummary...],
  nextCursor }`, where a `FrameSummary` is `{ sequence, ts, direction, binary, body }`
  and `after` is the last `sequence` you saw.
- `GET /api/ws/<deviceId>/<wsId>/frames/<sequence>/body`: one frame's payload, same
  `200`/`410`/`404` contract as an entry body.

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8787/api/ws?device=com.acme.app-Pixel"
```

## `GET /api/entries/wait`

A long-poll: answer as soon as an entry after `afterSeq` matches, or after a
timeout.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8787/api/entries/wait?afterSeq=42&epoch=$EPOCH&bundleId=com.acme.app&method=POST&urlContains=/v1/login&completed=true&newOnly=true&timeoutMs=15000"
```

| Parameter | Default | Accepted values |
| --- | --- | --- |
| `afterSeq` | required | Non-negative integer, at most `lastSeq`. |
| `epoch` | none | Always send it; a foreign value is `409`. |
| `timeoutMs` | `10000` | Non-negative integer; values above `30000` act as `30000`. `0` answers at once. |
| `limit` | `1` | `1` to `50`. |
| `newOnly` | `false` | `true` or `false`, as on `afterSeq` reads. |
| `device`, `externalId`, `bundleId` | | [Device scope](#device-scope). |
| `method`, `urlContains`, `status`, `source`, `completed` | | [Filters](#filters). |

`cursor` and `last` are refused (`400`). Parameter errors and `409 stale_cursor` are
the same as on the `afterSeq` read.

**Match.** If matching entries already exist after `afterSeq`, the answer is
immediate; otherwise the request is held until a write produces one. Checking the
store and registering the wait happen in the same synchronous step, so an entry
that arrives while the wait is being set up is not lost. An update that turns a
non-matching entry into a matching one (a response completing a request) counts.

```json
{"matched":true,"items":[EntrySummary...],"nextSeq":57,"lastSeq":57,"epoch":"q3l...",
 "now":1791136000000,"gap":false}
```

`items` holds up to `limit` matches in ascending `seq`; `nextSeq` is the `seq` of the
last one.

**Timeout.** Still HTTP `200`:

```json
{"matched":false,"items":[],"nearMisses":[EntrySummary...],"nextSeq":42,"lastSeq":61,
 "epoch":"q3l...","now":1791136015000,"gap":false}
```

`nextSeq` echoes your `afterSeq`. `nearMisses` holds up to 5 entries with a `seq`
above `afterSeq`, inside the device scope, that failed the other filters or
`newOnly`, newest first. Since nothing matched, these are simply the most recent
entries in scope since your cursor: use them to see what did happen (a `GET`
instead of a `POST`, a request still in flight, an update to an older entry).

`devices` is added to both shapes when the query named `externalId` or `bundleId`.
A device that connects, or announces the identity the scope names, after the wait
started is picked up, and its already stored traffic is checked.

**Limits and lifecycle.**

- At most **16** waits may be pending across the whole collector. A wait that would
  have to be held while 16 are pending is answered
  `429 {"error":"too_many_waits","limit":16}`. A wait answered at once (a match, or
  `timeoutMs=0`) never counts.
- A client that disconnects cancels its wait and frees the slot at once.
- A clear that covers the wait's scope (a full clear, or a device clear of a device
  in scope) ends the wait with the timeout shape and `gap: true`.
- Pausing the UI stream has no effect on waits.
- On shutdown, pending waits are answered with the timeout shape and
  `Connection: close`.
- Responses carry `Cache-Control: no-store`.

## Recommended client flow

1. Read the reader token, then `GET /api/status`. Keep `epoch` and `lastSeq`; the
   cursor is `lastSeq`.

   ```bash
   STATUS="$(curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/status)"
   EPOCH="$(echo "$STATUS" | jq -r .epoch)"; CURSOR="$(echo "$STATUS" | jq -r .lastSeq)"
   ```

2. Perform the action in the app (tap, launch, deep link).
3. Wait for the exchange, scoped to the device or app, with the request filters,
   `completed=true` and `newOnly=true`:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8787/api/entries/wait?afterSeq=$CURSOR&epoch=$EPOCH&externalId=emulator-5554&method=POST&urlContains=/v1/orders&completed=true&newOnly=true&timeoutMs=20000"
   ```

4. Judge the result client-side. Do not filter on `status`: a `500` then comes back
   at once as a verdict instead of a timeout. Check `gap` (records you never saw
   were removed) and, before trusting `newOnly`, the device's `startEvents` (see
   below). Fetch the detail or a body when you need headers or payload.
5. On a timeout, inspect `nearMisses`: it shows what the app did send after the
   cursor, which usually explains the miss (wrong path, wrong method, still in
   flight, other device).
6. To wait for the next exchange, call again with `afterSeq=<nextSeq>`. Note that
   `newOnly` compares `firstSeq` with the `afterSeq` of that call: an exchange that
   started before `nextSeq` but completes later fails `newOnly` on the chained call.
   To collect every exchange started after the original cursor, chain with
   `newOnly=false` and keep the items whose `firstSeq` is above the original cursor.
7. On `409`, re-baseline as described in [`epoch` and `409
   stale_cursor`](#epoch-and-409-stale_cursor); on `401`, re-read the token file.

## When an entry reaches the collector

What `firstSeq` marks depends on how many messages the source sends per exchange.

| Source | Messages per exchange | `firstSeq` marks | `newOnly` exact? |
| --- | --- | --- | --- |
| Atlantis, no request-start packets (fork default) | One, when the exchange completes | Arrival of the completed exchange | No |
| Atlantis with `emitRequestStart` on | Two with the same id: a start packet, then the completion | Arrival of the start packet | Yes |
| WSS ingest (`xhr`) | Two: `request`, then `response` with the same id | Arrival of the `request` | Yes |
| Proxy | Two: when the request has been received, then on the response or abort | Arrival of the request at the proxy | Yes |
| Replay | One, written once the replayed request finished or failed, before `POST /api/replay` returns | The end of the replay | Not needed: a cursor taken before the `POST` sees it as new |

Without request-start packets, a request that started **before** your cursor and
finished **after** it gets a `firstSeq` above the cursor and looks new, even with
`newOnly=true`. A client can estimate the start on the collector clock as
`receivedAt - durationMs`, but that is only a heuristic: it is wrong for packets
the SDK replays from its offline queue after a reconnect, which arrive long after
the exchange ended.

`Device.startEvents` is the signal. It becomes `true` the first time the collector
sees a start event from the device (an Atlantis request-start packet or a WSS
`request`), so before the device's first exchange it is absent even if the app
emits starts. It is per device record, not per source: on a device seen on both
channels, WSS `request` messages set it even when the Atlantis fork sends no start
packets. Proxy devices never set it, although proxy `firstSeq` does mark the start.

A request-start packet that arrives after its completion (an out-of-order replay
from the offline queue) is dropped whole: it neither overwrites the completed entry
nor takes a `seq`.

## The `redacted` marker

`redacted` is `{ request, response }` on every summary and detail. `request` is
`true` when a value in the URL query, the request headers or the request body was
masked; `response` likewise for the response headers and body. Masked values read
`***`. The flags never go back to `false` for the life of the entry. HAR exports
carry the marker as `_terminus.redacted` and JSON exports on the entry, only when a
side was masked. What is masked, and how to tune it, is in
[security.md](security.md#auth-material-is-redacted-before-storage).

## Limitations

- **Not seeing a request does not prove there was none.** The collector only sees
  what a capture channel reports. WebView traffic, gRPC outside OkHttp, and raw
  sockets are not captured. Without request-start packets, an Android response
  whose body is never read to the end is never sent to the collector at all.
- **The store is in memory.** A restart loses every entry, issues a new `epoch` and
  restarts `seq` at `0`. Retention also evicts old entries (see `gap`).
- **Late aliases are refused.** A WSS `hello` whose `atlantisDeviceKey` names an
  Atlantis device that already has stored entries is not applied (the collector
  logs `device alias conflict`), so the two channels stay two devices and a
  `device=` filter on one does not see the other. To avoid it, send the ingest
  `hello` before the Atlantis SDK starts, or use one channel, or scope by
  `externalId`/`bundleId` (which select both records when both carry the value).
- **iOS server-sent events are WebSocket sessions.** The iOS Atlantis fork reports an
  SSE exchange as a WebSocket package, so it is stored as a `websocket`-kind
  session, with no `seq`.
- **`ambiguous` detection is partial.** It covers only the Atlantis TLS listener; two
  apps sharing an id over another channel are not detected. When it is set, the
  traffic stays mixed under one device; the collector cannot split it.
- **Redaction is name-based.** See the honest limits in
  [security.md](security.md#what-redaction-does-not-cover).
