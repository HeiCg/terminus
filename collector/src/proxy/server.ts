import { getLocal, generateCACertificate, type Mockttp } from 'mockttp';
import type { CompletedRequest, CompletedResponse, WebSocketMessage, WebSocketClose, TlsHandshakeFailure, AbortedRequest, TlsPassthroughEvent } from 'mockttp';
import { randomUUID } from 'node:crypto';
import type net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../store.js';
import type { BodyStore } from '../bodyStore.js';
import { buildEntryInput, normalizeWsFrame, epochOf, type ProxyIds } from './normalize.js';
import { log } from '../log.js';
import { redactUrl } from '../redactor.js';
import type { EntryInput, TunnelInfo } from '../types.js';

// A collector-internal endpoint the proxy must NOT inspect: its TLS is tunnelled
// raw (so the device keeps seeing the collector's own pinned certificate, never a
// proxy-signed one) and its traffic is never recorded, so device tokens and auth
// headers never enter the proxy store.
export type CollectorEndpoint = { host: string; port: number };

export type ProxySourceOptions = {
  port: number;
  // The proxy's OWN certificate authority, in PEM. This is deliberately separate
  // from the collector's TLS identity (T03): it exists only to MITM QA device
  // traffic and is trusted only on the QA device, never installed collector-side.
  ca: { key: string; cert: string };
  store: Store;
  // Reserved for callers that want to observe/pre-check the bodies budget; the
  // store owns body admission internally, so the proxy path feeds through
  // store.addEntryInput like every other source.
  bodyStore?: BodyStore;
  excludedCollectorEndpoints: CollectorEndpoint[];
  // Device IPs explicitly permitted to use the proxy. A client outside this list
  // is rejected at the connection: the proxy is NEVER an open relay on the LAN.
  deviceAllowlist: string[];
  // Documented bind interface. NOTE: mockttp's listener binds all interfaces; the
  // real access boundary is `deviceAllowlist` (enforced per connection below).
  host?: string;
  minTlsVersion?: 'TLSv1.2' | 'TLSv1.3';
  // U5 (see tlsMode.ts): mockttp hostname patterns (`api.example.com`,
  // `*.example.com`), already validated. `tlsPassthrough` hosts are tunnelled raw
  // in addition to the collector's own; `tlsInterceptOnly` makes ONLY those hosts
  // intercepted (the collector's own hosts are then tunnelled because they are not
  // listed). Mutually exclusive: setting both throws.
  tlsPassthrough?: string[];
  tlsInterceptOnly?: string[];
};

// The cloud metadata service address. A proxy that forwarded to it would let a
// device (or anything on the LAN that reached the proxy) pull instance credentials,
// so it is refused as a destination regardless of the client allowlist.
export const CLOUD_METADATA_IP = '169.254.169.254';

export type ProxySource = {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly port: number;
  readonly sessionId: string;
};

export type ProxyCA = { key: string; cert: string; certPath: string };

// Load (or create) the proxy's own CA in a PRIVATE directory, kept separate from
// the collector's TLS identity (T03). The private key is 0600; the certificate is
// world-readable (0644) because it is meant to be copied onto the QA device (the M
// side reads it via TERMINUS_PROXY_CA as a PEM path) — it grants nothing without
// the key. QA-only: this CA is trusted only on the test device, never collector-side.
export async function loadOrCreateProxyCA(dir: string): Promise<ProxyCA> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700).catch(() => {});
  const keyPath = path.join(dir, 'proxy-ca.key');
  const certPath = path.join(dir, 'proxy-ca.pem');
  try {
    const key = await fsp.readFile(keyPath, 'utf8');
    const cert = await fsp.readFile(certPath, 'utf8');
    return { key, cert, certPath };
  } catch { /* generate below */ }
  const { key, cert } = await generateCACertificate();
  await fsp.writeFile(keyPath, key, { mode: 0o600 });
  await fsp.writeFile(certPath, cert, { mode: 0o644 });
  return { key, cert, certPath };
}

// The store record for one raw TLS tunnel (U5): a body-less `CONNECT` entry. While
// open it is in flight (status null); at close it gets status 200 (the tunnel was
// established) and its duration, or the passthrough error.
function tunnelEntry(ids: ProxyIds, url: string, info: TunnelInfo, error: string | null = null): EntryInput {
  const closed = info.closedAt != null;
  return {
    ...buildEntryInput({
      ids, startedAt: info.openedAt, method: 'CONNECT', url,
      status: closed && error == null ? 200 : null, statusText: closed && error == null ? 'OK' : '',
      durationMs: closed ? Math.max(0, info.closedAt! - info.openedAt) : null, error,
    }),
    tunnel: info,
  };
}

// Normalize an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) down to its IPv4 form
// so the allowlist compares apples to apples.
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// A create-only factory: it wires a mockttp proxy to the store as the additive
// `proxy` source. It does NOT start the listener — `start()` does, and the listener
// is OFF until then (QA-only, opt-in). Turning the proxy on or off touches only this
// source; Atlantis and the WSS ingest are wired elsewhere and are never gated by it.
export function createProxySource(options: ProxySourceOptions): ProxySource {
  const { port, ca, store, excludedCollectorEndpoints, deviceAllowlist } = options;
  const userPassthrough = options.tlsPassthrough ?? [];
  const interceptOnly = options.tlsInterceptOnly ?? [];
  if (userPassthrough.length && interceptOnly.length) throw new Error('proxy: tlsPassthrough and tlsInterceptOnly cannot both be set');
  const userTlsMode = userPassthrough.length > 0 || interceptOnly.length > 0;
  const collectorHosts = new Set(excludedCollectorEndpoints.map((e) => e.host));
  const sessionId = randomUUID();
  const allow = new Set(deviceAllowlist.map(normalizeIp));
  // One admission generation for the whole proxy source: freed on stop() so the
  // WS session-admission registry does not leak across restarts.
  const generation = `proxy:${sessionId}`;

  let server: Mockttp | null = null;
  let actualPort = port;

  // Per-exchange id state. mockttp reuses one id across the request/response/ws
  // events of a single exchange; we map that to our namespaced ids so both halves
  // land on the same store record. `proxy:<session>:<requestUUID>` for the record,
  // `proxy:<session>:<clientId>` for the device — the proxy's own identity, never a
  // guess at the real device/appVersion behind the IP.
  const httpIds = new Map<string, { ids: ProxyIds; req: CompletedRequest }>();
  const wsIds = new Map<string, ProxyIds>();
  // Raw TLS tunnels being recorded, by mockttp's passthrough event id, and the
  // live client TCP sockets by `ip:port` (filled from the listener's `connection`
  // event) so a tunnel can be closed for a disallowed client and its byte counts
  // read at close. mockttp exposes neither the socket nor tunnel byte counts.
  const tunnels = new Map<string, { ids: ProxyIds; url: string; info: TunnelInfo; sock: net.Socket | null }>();
  const clientSockets = new Map<string, net.Socket>();
  const sockKey = (ip: string | undefined, p: number | undefined): string => `${normalizeIp(ip)}:${p ?? ''}`;

  const clientIdOf = (ip: string | undefined): string => normalizeIp(ip) || 'unknown';
  const deviceIdOf = (ip: string | undefined): string => `proxy:${sessionId}:${clientIdOf(ip)}`;
  const newRecordId = (): string => `proxy:${sessionId}:${randomUUID()}`;

  const isExcludedDest = (dest: { hostname: string; port: number } | undefined): boolean => {
    if (!dest) return false;
    return excludedCollectorEndpoints.some((e) => e.host === dest.hostname && e.port === dest.port);
  };
  const isAllowedClient = (ip: string | undefined): boolean => allow.has(normalizeIp(ip));

  // A request we should turn into evidence: from an allowed client, not to a
  // collector-internal endpoint, and not to the cloud metadata service.
  const shouldRecord = (req: { remoteIpAddress?: string; destination?: { hostname: string; port: number } }): boolean =>
    isAllowedClient(req.remoteIpAddress) && !isExcludedDest(req.destination) && req.destination?.hostname !== CLOUD_METADATA_IP;

  // The single access decision, shared by the HTTP gate and the WebSocket guard
  // rule so both channels reject identically: refuse a cloud-metadata fetch and any
  // client outside the allowlist, but let a collector-internal endpoint through
  // (its TLS is tunnelled raw via tlsPassthrough, and it is dropped from recording
  // in the event handlers). Returns true when the connection must be refused.
  const shouldReject = (req: { remoteIpAddress?: string; destination?: { hostname: string; port: number } }): boolean => {
    const dest = req.destination;
    if (dest?.hostname === CLOUD_METADATA_IP) return true;
    if (isExcludedDest(dest)) return false; // collector-internal: tunnel, don't reject
    return !isAllowedClient(req.remoteIpAddress);
  };

  // Connection gate applied by the HTTP passthrough rule BEFORE upstream is
  // contacted. Rejecting here (`response: 'close'`) means a disallowed client or a
  // metadata fetch never reaches the network — the allowlist is a real boundary,
  // not just a recording filter.
  const gate = (req: CompletedRequest): { response: 'close' } | undefined => {
    if (shouldReject(req)) {
      log.warn('proxy: refused HTTP connection', req.destination?.hostname, normalizeIp(req.remoteIpAddress));
      return { response: 'close' };
    }
    return undefined;
  };

  async function attach(s: Mockttp): Promise<void> {
    // ---- HTTP ------------------------------------------------------------
    // Out of the capture scope (U5): still forwarded upstream by the rules below,
    // just never recorded (admitScope counts the drop).
    await s.on('request', async (req: CompletedRequest) => {
      if (!shouldRecord(req)) return;
      if (!store.admitScope(req.url)) return;
      const ids: ProxyIds = { id: newRecordId(), deviceId: deviceIdOf(req.remoteIpAddress) };
      httpIds.set(req.id, { ids, req });
      store.touchDevice({ deviceId: ids.deviceId, platform: 'proxy', appVersion: '', buildProfile: 'proxy', dropped: 0, lastSeen: Date.now() });
      const requestBuf = await req.body.getDecodedBuffer().catch(() => req.body.buffer);
      store.addEntryInput(buildEntryInput({
        ids, startedAt: epochOf(req.timingEvents), method: req.method, url: req.url,
        requestHeaders: req.headers, requestBuf: requestBuf ?? null,
      }));
    });

    await s.on('response', async (res: CompletedResponse) => {
      const pending = httpIds.get(res.id);
      if (!pending) return;
      httpIds.delete(res.id);
      const requestBuf = await pending.req.body.getDecodedBuffer().catch(() => pending.req.body.buffer);
      const responseBuf = await res.body.getDecodedBuffer().catch(() => res.body.buffer);
      const t = res.timingEvents;
      const durationMs = t.responseSentTimestamp != null && t.startTimestamp != null ? Math.round(t.responseSentTimestamp - t.startTimestamp) : null;
      store.addEntryInput(buildEntryInput({
        ids: pending.ids, startedAt: epochOf(pending.req.timingEvents), method: pending.req.method, url: pending.req.url,
        requestHeaders: pending.req.headers, requestBuf: requestBuf ?? null,
        status: res.statusCode, statusText: res.statusMessage, responseHeaders: res.headers, responseBuf: responseBuf ?? null,
        durationMs,
      }));
    });

    await s.on('abort', async (req: AbortedRequest) => {
      const pending = httpIds.get(req.id);
      if (!pending) return;
      httpIds.delete(req.id);
      const requestBuf = await pending.req.body.getDecodedBuffer().catch(() => pending.req.body.buffer);
      store.addEntryInput(buildEntryInput({
        ids: pending.ids, startedAt: epochOf(pending.req.timingEvents), method: pending.req.method, url: pending.req.url,
        requestHeaders: pending.req.headers, requestBuf: requestBuf ?? null,
        error: req.error?.code ? `aborted ${req.error.code}` : 'aborted',
      }));
    });

    // ---- WebSocket -------------------------------------------------------
    await s.on('websocket-request', (req: CompletedRequest) => {
      if (!shouldRecord(req)) return;
      if (!store.admitScope(req.url)) return;
      const ids: ProxyIds = { id: newRecordId(), deviceId: deviceIdOf(req.remoteIpAddress) };
      wsIds.set(req.id, ids);
      store.touchDevice({ deviceId: ids.deviceId, platform: 'proxy', appVersion: '', buildProfile: 'proxy', dropped: 0, lastSeen: Date.now() });
      store.addWsSession({ wsId: ids.id, deviceId: ids.deviceId, source: 'proxy', url: redactUrl(req.url), openedAt: epochOf(req.timingEvents), generation, via: 'open' });
    });

    const onMessage = (msg: WebSocketMessage): void => {
      const ids = wsIds.get(msg.streamId);
      if (!ids) return;
      const { frame, bytes } = normalizeWsFrame(msg.content, msg.isBinary, msg.direction, epochOf(msg.timingEvents, msg.eventTimestamp));
      store.appendWsFrame(ids.id, frame, bytes, ids.deviceId);
    };
    await s.on('websocket-message-received', onMessage);
    await s.on('websocket-message-sent', onMessage);
    await s.on('websocket-close', (c: WebSocketClose) => {
      const ids = wsIds.get(c.streamId);
      if (!ids) return;
      wsIds.delete(c.streamId);
      store.closeWs(ids.id, epochOf(c.timingEvents, c.timingEvents.wsClosedTimestamp), c.closeCode ?? 0, c.closeReason, ids.deviceId);
    });

    // ---- TLS handshake failure ------------------------------------------
    // A client that refused the proxy's certificate (pinning, its own trust store)
    // produces no HTTP exchange; record it as a distinct piece of evidence so the
    // coverage matrix can mark the flow `pinning`/`bypass` rather than lose it.
    await s.on('tls-client-error', (e: TlsHandshakeFailure) => {
      if (!isAllowedClient(e.remoteIpAddress)) return;
      const dest = e.destination;
      const host = e.tlsMetadata?.sniHostname ?? dest?.hostname ?? 'unknown';
      if (!store.admitScope(`https://${host}`)) return;
      const ids: ProxyIds = { id: newRecordId(), deviceId: deviceIdOf(e.remoteIpAddress) };
      store.touchDevice({ deviceId: ids.deviceId, platform: 'proxy', appVersion: '', buildProfile: 'proxy', dropped: 0, lastSeen: Date.now() });
      store.addEntryInput(buildEntryInput({
        ids, startedAt: Math.round(e.timingEvents.startTime), method: '', url: `https://${host}`,
        error: `tls_error ${e.failureCause}`,
      }));
    });

    // ---- Raw TLS tunnels (U5) --------------------------------------------
    // A TLS connection mockttp passes through WITHOUT interception (a pass-through
    // host, any host outside the intercept-only list, or a collector-internal host)
    // never reaches the HTTP gate above, so the access boundary is applied here: a
    // client outside the allowlist, or a tunnel to the metadata address, is closed
    // as soon as mockttp reports it (before the upstream can answer), so a
    // pass-through host is never an open relay. Collector-internal tunnels keep
    // their pre-U5 behaviour: never refused here, never recorded.
    // A recorded tunnel is a `CONNECT` entry (no headers/bodies; nothing inside the
    // tunnel is visible) whose `tunnel` field carries host, port, SNI and, at close,
    // the client connection's byte counts. It is in flight (status null) while open
    // and gets status 200 and its duration when it closes.
    await s.on('tls-passthrough-opened', (e: TlsPassthroughEvent) => {
      const dest = e.destination;
      if (collectorHosts.has(dest.hostname)) return;
      const sock = clientSockets.get(sockKey(e.remoteIpAddress, e.remotePort)) ?? null;
      if (dest.hostname === CLOUD_METADATA_IP || !isAllowedClient(e.remoteIpAddress)) {
        log.warn('proxy: refused TLS tunnel', dest.hostname, normalizeIp(e.remoteIpAddress));
        sock?.destroy();
        return;
      }
      const host = dest.hostname;
      const url = `https://${host.includes(':') ? `[${host}]` : host}:${dest.port}`;
      if (!store.admitScope(url)) return;
      const ids: ProxyIds = { id: newRecordId(), deviceId: deviceIdOf(e.remoteIpAddress) };
      const openedAt = Math.round(e.timingEvents.startTime);
      const info: TunnelInfo = { host, port: dest.port, sni: e.tlsMetadata?.sniHostname ?? null, bytesUp: null, bytesDown: null, openedAt, closedAt: null };
      store.touchDevice({ deviceId: ids.deviceId, platform: 'proxy', appVersion: '', buildProfile: 'proxy', dropped: 0, lastSeen: Date.now() });
      if (store.addEntryInput(tunnelEntry(ids, url, info))) tunnels.set(e.id, { ids, url, info, sock });
    });
    await s.on('tls-passthrough-closed', (e: TlsPassthroughEvent) => {
      const t = tunnels.get(e.id);
      if (!t) return;
      tunnels.delete(e.id);
      const te = e.timingEvents;
      const closedAt = te.disconnectTimestamp != null ? Math.round(te.startTime + (te.disconnectTimestamp - te.connectTimestamp)) : Date.now();
      const failure = e.tags.find((tag) => tag.startsWith('tls-passthrough-error:'));
      const info: TunnelInfo = { ...t.info, closedAt, bytesUp: t.sock?.bytesRead ?? null, bytesDown: t.sock?.bytesWritten ?? null };
      store.addEntryInput(tunnelEntry(t.ids, t.url, info, failure ? `tunnel_error ${failure.slice('tls-passthrough-error:'.length)}` : null));
    });

    // Passthrough rules. The gate rejects disallowed clients / metadata fetches
    // before upstream. `ignoreHostHttpsErrors` lets QA capture flows whose upstream
    // uses a cert Node would otherwise reject; it never weakens the collector's own
    // TLS (that path is tunnelled, below).
    // WebSocket passthrough has no beforeRequest hook, so the access boundary is a
    // higher-priority guard rule registered FIRST: it MATCHES upgrades that must be
    // refused (disallowed client, metadata destination) and closes them, so a
    // non-allowlisted LAN client's ws:// or post-MITM wss:// upgrade is rejected at
    // the rule, not merely dropped from recording. The passthrough rule below then
    // only ever sees allowed upgrades.
    await s.forAnyWebSocket().matching((req) => shouldReject(req)).thenCloseConnection();
    await s.forAnyWebSocket().thenPassThrough({ ignoreHostHttpsErrors: true });
    await s.forAnyRequest().thenPassThrough({ ignoreHostHttpsErrors: true, beforeRequest: gate });
  }

  return {
    get port() { return actualPort; },
    sessionId,
    async start() {
      if (server) return;
      server = getLocal({
        https: {
          key: ca.key, cert: ca.cert,
          // Collector-internal hosts are tunnelled raw: no MITM, so the device keeps
          // pinning the collector's real certificate through the proxy. In
          // intercept-only mode they are simply not on the intercept list.
          ...(interceptOnly.length
            ? { tlsInterceptOnly: interceptOnly.map((hostname) => ({ hostname })) }
            : { tlsPassthrough: [...new Set([...collectorHosts, ...userPassthrough])].map((hostname) => ({ hostname })) }),
          tlsServerOptions: { minVersion: options.minTlsVersion ?? 'TLSv1.2' },
        },
        // The proxy must never rewrite CORS on captured traffic.
        cors: false,
        recordTraffic: false,
      });
      await server.start(port);
      actualPort = server.port;
      // Observe the client TCP sockets (first sighting wins: mockttp re-emits
      // `connection` for the same socket after a CONNECT). This reaches into
      // mockttp's listener because it exposes no socket for a raw tunnel; when that
      // is impossible and user TLS modes are on, refuse to start (fail closed:
      // without it a pass-through host would be an open relay).
      const raw = (server as unknown as { server?: { prependListener?: unknown } }).server;
      if (raw && typeof raw.prependListener === 'function') {
        (raw as unknown as net.Server).prependListener('connection', (sock: net.Socket) => {
          const key = sockKey(sock.remoteAddress, sock.remotePort);
          if (clientSockets.has(key)) return;
          clientSockets.set(key, sock);
          sock.once('close', () => { if (clientSockets.get(key) === sock) clientSockets.delete(key); });
        });
      } else if (userTlsMode) {
        const s = server; server = null; await s.stop();
        throw new Error('proxy: cannot observe client connections in this mockttp version; TLS pass-through modes are unavailable');
      } else {
        log.warn('proxy: cannot observe client connections; tunnel byte counts are unavailable');
      }
      await attach(server);
      log.info(`proxy source listening on ${options.host ?? '0.0.0.0'}:${server.port} (session ${sessionId}); allowlist ${[...allow].join(',') || '(empty)'}`);
      if (userPassthrough.length) log.info(`proxy: TLS pass-through (not intercepted): ${userPassthrough.join(', ')}`);
      if (interceptOnly.length) log.info(`proxy: TLS intercept-only (every other host is tunnelled): ${interceptOnly.join(', ')}`);
    },
    async stop() {
      const s = server; server = null;
      httpIds.clear(); wsIds.clear(); tunnels.clear(); clientSockets.clear();
      store.closeWsGeneration(generation);
      if (s) await s.stop();
    },
  };
}
