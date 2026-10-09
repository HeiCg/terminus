import type { Mockttp, RawPassthroughEvent, RawPassthroughDataEvent, TlsPassthroughEvent } from 'mockttp';
import type net from 'node:net';
import type { Store } from '../store.js';
import type { StreamInfo } from '../types.js';
import { normalizeWsFrame, type NormalizedFrame, type ProxyIds } from './normalize.js';
import { log } from '../log.js';

// U7: raw TCP/TLS stream capture on the proxy source.
//
// mockttp 4.6 relays traffic that is "definitely not HTTP" (inside a CONNECT or
// SOCKS tunnel, after TLS unwrapping when the proxy intercepted the TLS) when it
// is built with `passthrough: ['unknown-protocol']`, and reports each relay as
// `raw-passthrough-opened` (id, destination host/port, client ip/port, timing),
// `raw-passthrough-data` (id, direction 'received' = from the client / 'sent' = to
// the client, the chunk bytes, a monotonic timestamp) and `raw-passthrough-closed`
// (the opened payload plus `disconnectTimestamp`, and an
// `raw-passthrough-error:<code>` tag on a failure). The events carry no TLS
// information and arrive after mockttp has ALREADY dialled the upstream, so:
//
//   - the ACCESS GATE runs earlier, in a wrapper around mockttp's internal
//     `passthroughSocket(type, socket, host, port)`: the one method both the raw
//     relay AND the TLS pass-through tunnel go through. For either it refuses a
//     client outside the allowlist and a refused destination (proxy/destGuard.ts:
//     the metadata range always; loopback, unspecified, link-local and the
//     collector's own addresses unless TERMINUS_PROXY_ALLOW_LOCAL=1) by destroying
//     the client socket BEFORE any upstream connection exists. A host NAME is
//     resolved by the gate and mockttp is handed the checked ADDRESS to dial; the
//     events are then given back the name the client asked for. The wrapper is
//     installed whenever the proxy runs (TLS pass-through always exists: the
//     collector's own hosts are tunnelled); when it cannot be installed (a mockttp
//     without that method) the proxy refuses to start: it fails closed rather
//     than relay ungated.
//   - the same wrapper reads what the socket knows and the events do not: whether
//     the last hop was TLS the proxy terminated (kind `tls`, plaintext) or plain
//     TCP (kind `tcp`), and the SNI. It is handed to the opened event by the
//     client's `ip:port`, the key mockttp's own event data is built from.
//
// Stream sessions are recorded only when raw streams are on
// (TERMINUS_PROXY_RAW_STREAMS=1, `recordSessions`); with them off mockttp is built
// without unknown-protocol passthrough and non-HTTP traffic in a tunnel is closed,
// as in 0.2. The gate runs either way.
//
// A TLS pass-through tunnel (U5, `tls-passthrough-*`) also becomes a stream
// session, kind `tls` with `plaintext: false` and NO frames: its bytes are
// ciphertext the proxy never sees. Its CONNECT entry is still recorded by the
// server as before; the session is the stream view of the same tunnel.
//
// Chunks become frames exactly like WebSocket frames: `out` client→server, `in`
// server→client, the same per-message cap, a text chunk redacted, a binary chunk
// (NUL byte or invalid UTF-8) kept verbatim.

// What the proxy decided for one relay: refuse it (destroy the client socket),
// skip it (a collector-internal endpoint: relay, never record) or record it.
export type RawVerdict = 'refuse' | 'skip' | 'record';
// The gate's answer. `dialHost` is what mockttp dials: the checked address for a
// resolved name (never re-resolved), or the host as given.
export type GateDecision = { verdict: 'refuse'; reason: string } | { verdict: 'skip' | 'record'; dialHost: string };

export type RawStreamDeps = {
  store: Store;
  // The proxy source's admission generation (freed on stop).
  generation: string;
  // The single pre-dial access decision, shared with the server's other channels.
  // `type` is 'raw' for an unknown-protocol relay, 'tls' for a TLS tunnel; `port`
  // is 443 for an SNI-only tunnel.
  gate(clientIp: string | undefined, host: string, port: number, type: 'raw' | 'tls'): Promise<GateDecision>;
  // Record stream sessions (TERMINUS_PROXY_RAW_STREAMS). The gate runs regardless.
  recordSessions: boolean;
  // The proxy's own identity namespace.
  deviceIdOf(clientIp: string | undefined): string;
  newRecordId(): string;
  normalizeIp(ip: string | undefined): string;
};

export type RawStreamCapture = {
  // Wrap the server's passthrough entry point; call BEFORE `start()` (mockttp
  // binds it when it builds its listener). False when the wrapper cannot be
  // installed: the caller must then refuse to start (fail closed).
  install(server: Mockttp): boolean;
  // Subscribe to the raw and TLS-tunnel events; call after `start()` and BEFORE
  // any other tls-passthrough listener (it restores the dialled name first).
  attach(server: Mockttp): Promise<void>;
  clear(): void;
};

const strictUtf8 = new TextDecoder('utf8', { fatal: true });

// A chunk is binary when it carries a NUL byte or is not valid UTF-8; binary
// bytes are kept verbatim, text goes through the redactor (normalizeWsFrame).
export function isBinaryChunk(buf: Uint8Array): boolean {
  if (buf.includes(0)) return true;
  try { strictUtf8.decode(buf); return false; } catch { return true; }
}

// One stream chunk → the store's frame shape (the WS frame normalizer, so the
// caps and redaction are identical). `direction` is from the client's side:
// 'received' = client→server (`out`), 'sent' = server→client (`in`).
export function normalizeStreamChunk(content: Uint8Array, direction: 'sent' | 'received', ts: number): NormalizedFrame {
  return normalizeWsFrame(content, isBinaryChunk(content), direction, ts);
}

// The session url of a stream: `tcp://host:port` / `tls://host:port` (an IPv6
// literal bracketed). The capture scope matches on its host like any url.
export function streamUrl(kind: 'tcp' | 'tls', host: string, port: number): string {
  return `${kind}://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

type Pending = { kind: 'tcp' | 'tls'; sni: string | null };
type Live = { ids: ProxyIds; startTime: number; connectTimestamp: number };

// mockttp keeps its per-socket state under module-private symbols; the two the
// gate needs are found by their description (no deep import of mockttp internals).
function symbolValue(socket: object, description: string): unknown {
  const sym = Object.getOwnPropertySymbols(socket).find((s) => s.description === description);
  return sym ? (socket as Record<symbol, unknown>)[sym] : undefined;
}

type PassthroughFn = (type: 'raw' | 'tls', socket: net.Socket, hostname: string, port?: number) => void;

export function createRawStreamCapture(deps: RawStreamDeps): RawStreamCapture {
  const { store, generation } = deps;
  // Stream metadata from the gate, by client `ip:port`, until the opened event.
  const pending = new Map<string, Pending>();
  // TLS tunnels the gate admitted for recording, by client `ip:port`.
  const tlsPending = new Set<string>();
  // The host the client asked for, when mockttp was handed a resolved address.
  const askedHost = new Map<string, string>();
  // Recorded raw streams and TLS-tunnel sessions, by mockttp event id.
  const live = new Map<string, Live>();
  const tunnels = new Map<string, Live>();
  const keyOf = (ip: string | undefined, port: number | undefined): string => `${deps.normalizeIp(ip)}:${port ?? ''}`;

  function openSession(kind: 'tcp' | 'tls', e: RawPassthroughEvent, stream: StreamInfo): Live | null {
    const ids: ProxyIds = { id: deps.newRecordId(), deviceId: deps.deviceIdOf(e.remoteIpAddress) };
    const url = streamUrl(kind, stream.host, stream.port);
    store.touchDevice({ deviceId: ids.deviceId, platform: 'proxy', appVersion: '', buildProfile: 'proxy', dropped: 0, lastSeen: Date.now() });
    const outcome = store.addWsSession({
      wsId: ids.id, deviceId: ids.deviceId, source: 'proxy', url, openedAt: Math.round(e.timingEvents.startTime),
      kind, httpEntryKey: null, stream, generation, via: 'open',
    });
    // Out of the capture scope (or refused by admission): still relayed, never stored.
    if (outcome === 'dropped' || outcome === 'overload') return null;
    return { ids, startTime: e.timingEvents.startTime, connectTimestamp: e.timingEvents.connectTimestamp };
  }

  function closeSession(map: Map<string, Live>, e: RawPassthroughEvent): void {
    const s = map.get(e.id);
    if (!s) return;
    map.delete(e.id);
    const te = e.timingEvents as RawPassthroughEvent['timingEvents'] & { disconnectTimestamp?: number };
    const closedAt = te.disconnectTimestamp != null ? Math.round(te.startTime + (te.disconnectTimestamp - te.connectTimestamp)) : Date.now();
    const failure = e.tags.find((t) => /-passthrough-error:/.test(t));
    const reason = failure ? `error ${failure.slice(failure.indexOf(':') + 1)}` : 'closed';
    store.closeWs(s.ids.id, closedAt, null, reason, s.ids.deviceId);
  }

  return {
    install(server) {
      const target = server as unknown as { passthroughSocket?: PassthroughFn };
      const original = target.passthroughSocket;
      if (typeof original !== 'function') return false;
      target.passthroughSocket = function (this: unknown, type, socket, hostname, port) {
        const dial = original.bind(this);
        const parent = (socket as net.Socket & { _parent?: net.Socket })._parent;
        const ip = socket.remoteAddress ?? parent?.remoteAddress;
        const rport = socket.remotePort ?? parent?.remotePort;
        const key = keyOf(ip, rport);
        // Hold the client's bytes while the gate decides (it may resolve a name);
        // mockttp's pipe() resumes the socket once it relays.
        socket.pause();
        const refuse = (reason: string): void => {
          log.warn(`proxy: refused ${type === 'raw' ? 'raw stream' : 'TLS tunnel'}`, hostname, deps.normalizeIp(ip), reason);
          socket.destroy();
        };
        deps.gate(ip, hostname, port ?? 443, type).then((d) => {
          if (d.verdict === 'refuse') return refuse(d.reason);
          if (socket.destroyed) return;
          const forget: (() => void)[] = [];
          if (d.dialHost !== hostname) { askedHost.set(key, hostname); forget.push(() => askedHost.delete(key)); }
          if (d.verdict === 'record' && deps.recordSessions) {
            if (type === 'raw') {
              const tlsHop = symbolValue(socket, 'last-hop-encrypted') === true;
              const sni = (socket as net.Socket & { servername?: string | false }).servername;
              pending.set(key, { kind: tlsHop ? 'tls' : 'tcp', sni: typeof sni === 'string' && sni ? sni : null });
              forget.push(() => pending.delete(key));
            } else {
              tlsPending.add(key);
              forget.push(() => tlsPending.delete(key));
            }
          }
          if (forget.length) socket.once('close', () => { for (const f of forget) f(); });
          dial(type, socket, d.dialHost, port);
        }, (e: unknown) => refuse(`gate error: ${String(e)}`));
      };
      return true;
    },

    async attach(s) {
      // First: give the events back the host the client asked for (mockttp only
      // knows the address it was told to dial). Every later listener, and the
      // closed event (it shares the destination object), then sees the name.
      const restore = (e: RawPassthroughEvent | TlsPassthroughEvent): void => {
        const h = askedHost.get(keyOf(e.remoteIpAddress, e.remotePort));
        if (h) { e.destination.hostname = h; (e as { hostname?: string }).hostname = h; }
      };
      await s.on('raw-passthrough-opened', restore);
      await s.on('tls-passthrough-opened', restore);

      await s.on('raw-passthrough-opened', (e: RawPassthroughEvent) => {
        const k = keyOf(e.remoteIpAddress, e.remotePort);
        const p = pending.get(k);
        if (!p) return; // refused, collector-internal (skip) or sessions off: never recorded
        pending.delete(k);
        const dest = e.destination;
        const sess = openSession(p.kind, e, { host: dest.hostname, port: dest.port, sni: p.sni, plaintext: true });
        if (sess) live.set(e.id, sess);
      });
      await s.on('raw-passthrough-data', (d: RawPassthroughDataEvent) => {
        const sess = live.get(d.id);
        if (!sess) return;
        const ts = Math.round(sess.startTime + (d.eventTimestamp - sess.connectTimestamp));
        const { frame, bytes } = normalizeStreamChunk(d.content, d.direction, ts);
        store.appendWsFrame(sess.ids.id, frame, bytes, sess.ids.deviceId, 'proxy');
      });
      await s.on('raw-passthrough-closed', (e: RawPassthroughEvent) => closeSession(live, e));

      // TLS pass-through tunnels: metadata-only stream sessions, for the tunnels
      // the gate admitted for recording. The server's own tls-passthrough handler
      // counts a scope drop for the CONNECT entry, so this one only records what
      // is in scope, without counting the drop twice.
      await s.on('tls-passthrough-opened', (e: TlsPassthroughEvent) => {
        const k = keyOf(e.remoteIpAddress, e.remotePort);
        if (!tlsPending.delete(k)) return;
        const dest = e.destination;
        if (!store.inScope(streamUrl('tls', dest.hostname, dest.port))) return;
        const sess = openSession('tls', e, { host: dest.hostname, port: dest.port, sni: e.tlsMetadata?.sniHostname ?? null, plaintext: false });
        if (sess) tunnels.set(e.id, sess);
      });
      await s.on('tls-passthrough-closed', (e: TlsPassthroughEvent) => closeSession(tunnels, e));
    },

    clear() { pending.clear(); tlsPending.clear(); askedHost.clear(); live.clear(); tunnels.clear(); },
  };
}
