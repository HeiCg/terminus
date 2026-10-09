# @terminus/mcp

`terminus-mcp` is an [MCP](https://modelcontextprotocol.io) server that gives Claude
Code, Claude Desktop, or any other MCP client read access to the traffic a local
[Terminus](../collector) collector captured. It speaks MCP over stdio and calls
the collector's HTTP [read API](../docs/read-api.md) on `127.0.0.1:8787`. It needs
a collector at version 0.2.0 or newer.

Typical use: take a cursor with `terminus_status`, act in the app, then call
`terminus_wait` to catch the request the action caused, and `terminus_entry` to
read its headers and body.

## Install / build

From the monorepo root:

```sh
npm install                      # installs every workspace and builds mcp/dist
npm run build -w @terminus/mcp   # rebuild after a change: emits mcp/dist/main.js
```

Run it by the built path, or through the workspace bin:

```sh
node mcp/dist/main.js --help
npx terminus-mcp --help          # from the repo root, after npm install
```

Like the CLI, the server reuses collector and CLI sources by path, so `tsc` emits
a nested tree (`dist/mcp/src/...`). `dist/main.js` is a two-line shebang shim that
loads it, so the path you configure stays short and stable.

## Wiring it into Claude

### Claude Code

```sh
claude mcp add terminus -- node /abs/path/to/proxy_2/mcp/dist/main.js
```

On the same machine as the collector no token is needed (see below). To pass one
explicitly, or to reach a non-default port:

```sh
claude mcp add terminus -e TERMINUS_TOKEN="$(cat "$HOME/Library/Application Support/Terminus/reader-token")" \
  -- node /abs/path/to/proxy_2/mcp/dist/main.js --port 8787
```

On Linux the file is `${XDG_STATE_HOME:-$HOME/.local/state}/terminus/reader-token`.

A token passed this way stops working when the collector restarts (tokens rotate
on every start). Leaving it out and letting the server read the token file avoids
that.

### Claude Desktop

In `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "terminus": {
      "command": "node",
      "args": ["/abs/path/to/proxy_2/mcp/dist/main.js"],
      "env": {}
    }
  }
}
```

Put `TERMINUS_TOKEN`, `TERMINUS_PORT` or `TERMINUS_STATE_DIR` in `env` if you need
them. Restart Claude Desktop after editing the file.

## Configuration

| Setting | Flag | Environment | Default |
| --- | --- | --- | --- |
| Collector host | `--host` | `TERMINUS_HOST` | `127.0.0.1` |
| Collector port | `--port` | `TERMINUS_PORT` | `8787` |
| Token | `--token` | `TERMINUS_TOKEN` | the token files below |
| State directory | | `TERMINUS_STATE_DIR` | the collector's platform default |
| Replay opt-in | | `TERMINUS_MCP_ALLOW_REPLAY=1` | off |

The token is resolved in this order: `--token`, `TERMINUS_TOKEN`, then the files a
running collector writes in its state directory: **`reader-token` first**, then
`admin-token`. A token read from a file is re-read on every call, so a collector
restart is picked up without restarting the server. With no token at all the
server still starts, and each tool call explains what is missing.

The reader token is the default on purpose: it can only read (`GET` on status,
devices, entries, waits and WebSocket captures) and cannot clear, pause, pair,
export or replay. See [security.md](../docs/security.md#the-reader-token-for-local-automation).

The server logs to stderr only (stdout is the MCP channel) and never prints a
token.

## Tools

| Tool | Input | What it returns |
| --- | --- | --- |
| `terminus_status` | none | Version, `epoch`, `lastSeq`, `now`, paused, connected devices, retention counters. |
| `terminus_devices` | `externalId?`, `bundleId?` | One line per device: id, platform, app, bundle id, external id, last seen. |
| `terminus_entries` | `afterSeq?`, `last?`, `epoch?`, `newOnly?`, `device?`, `externalId?`, `bundleId?`, `method?`, `urlContains?`, `status?`, `source?`, `completed?`, `q?`, `limit?` | A header line (`nextSeq`, `lastSeq`, `epoch`, `gap`, `hasMore`) and one compact line per entry. Without `afterSeq` or `last`, the last 20. |
| `terminus_entry` | `deviceId`, `id`, `bodies?` (`none`, `request`, `response`, `both`; default `none`), `maxBodyBytes?` (default 16384) | Method, URL, status, timings, headers, the redaction marker, and optionally the bodies. |
| `terminus_wait` | `afterSeq`, `epoch?`, `timeoutMs?` (default 10000, max 30000), `newOnly?` (default true), `completed?` (default true), scope and filters, `q?`, `limit?` | The matching entries, or on timeout the `nearMisses` and the `nextSeq` to chain with. |
| `terminus_ws_sessions` | `device?`, `kind?` (`websocket`, `sse`, `tcp`, `tls`), `last?` (default 20) | One line per WebSocket/SSE session or raw TCP/TLS stream session, with its kind (a stream also shows `sni=` and `[metadata-only]` for a TLS pass-through tunnel). |
| `terminus_ws_frames` | `deviceId`, `wsId`, `after?`, `limit?` (default 50), `maxFrameBytes?` (default 2048) | One line per frame with its payload. |
| `terminus_replay` | `deviceId`, `id`, `overrides?` (`method`, `url`, `headers`, `body` or `bodyBase64`), `withCredentials?` (default false) | Only registered with the admin token and the opt-in. The new entry's line. |

`q` is an expression in the collector's [filter language](../docs/read-api.md#filter-language)
(for example `status >= 500 or (error)`), ANDed with the other filters. It is sent
only to a collector that advertises the `query` capability; an older one gets a
tool error instead of an unfiltered answer. `bodyBase64` (raw bytes, binary-safe)
likewise needs `replay-bytes`.

An entry line looks like:

```
#123 POST api.x.com/v1/cart 201 142ms req 1.2KB res 3.4KB [device=pixel-8 id=req-42] [redacted:req]
```

`firstSeq=` is added when the entry is an update of an exchange that existed
before (its response arrived later). A proxy entry that an
[interception rule](../docs/read-api.md#interception-rules) changed ends with
`[rules:<name>(<action>),...]`, plus `[mocked]` when a rule answered without
contacting upstream; `terminus_entry` lists those rules and the device's original
method/URL when a rewrite changed them. Rules are edited only in the collector UI
or its admin API: the MCP server stays read-only. The list tools also return the
collector's JSON as MCP `structuredContent`.

Bodies come back as UTF-8 text when they decode, otherwise as a hex dump of the
first bytes (at most 512), and are cut at `maxBodyBytes` with an explicit
`[truncated N bytes]` note.

Errors are tool results with `isError: true`, never a crash: collector not
reachable, `401` (token wrong or from before a restart), `403 forbidden_scope`
(the reader token on an admin route), `409 stale_cursor` (the collector restarted:
call `terminus_status` again), `429` (too many pending waits), `400` (a bad
parameter). Against a collector without `apiVersion` 1 every tool answers
`Terminus collector too old: needs 0.2.0+`.

## Replay

`terminus_replay` re-sends a captured request from your machine to the real
server, with real side effects. It is not exposed at all unless both are true:

- the token in use is the admin token (passed with `--token`/`TERMINUS_TOKEN` and
  equal to the `admin-token` file, or read from that file because no
  `reader-token` file exists), and
- `TERMINUS_MCP_ALLOW_REPLAY=1` is set.

It sends the same request as `terminus replay` in the CLI: captured credentials
(`Authorization`, `Cookie`, ...) are stripped unless `withCredentials` is true.

## Security

- **Captured traffic is untrusted input.** An app under test, or any server it
  talks to, controls URLs, headers, bodies and frames, and can write text aimed at
  the assistant reading them. The server wraps every piece of captured content in a
  block marked `BEGIN/END UNTRUSTED CAPTURED DATA` with a random per-result nonce,
  escapes control and bidi characters so captured text cannot fake new lines, caps
  body and frame sizes, and says in every tool description that this content is
  data, never instructions. That lowers the risk; it does not remove it. Do not
  give an assistant that reads captured traffic tools that can act on your behalf
  without your review.
- **What the assistant sees is what the collector stored.** Redaction happens at
  ingest (masked values read `***`); it is name-based and has the limits listed in
  [security.md](../docs/security.md#what-redaction-does-not-cover). Unredacted
  secrets in bodies reach the model.
- **Prefer the reader token.** It is the default; replay needs an explicit opt-in.
- The collector API is loopback-only, and so is this server's default host.
