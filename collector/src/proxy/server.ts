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
import { createRawStreamCapture } from './rawStreams.js';
import type { RulesStore } from '../rulesStore.js';
import { createRuleRunner, ruleEntryFields, type RuleEffects } from './rules.js';
import { isMetadataHost } from '../netAddr.js';
import { createDestGuard, createMetadataResolver, type Lookup } from './destGuard.js';

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
  // U7 (see rawStreams.ts): relay and record non-HTTP TCP/TLS streams inside a
  // CONNECT/SOCKS tunnel (default off; TERMINUS_PROXY_RAW_STREAMS=1; off, such
  // traffic is closed as in 0.2), and accept SOCKS v4/v5 on the same port
  // (default off; TERMINUS_PROXY_SOCKS=1).
  rawStreams?: boolean;
  socks?: boolean;
  // Let raw streams, TLS tunnels and SOCKS reach loopback, unspecified,
  // link-local and the collector's own addresses (default off;
  // TERMINUS_PROXY_ALLOW_LOCAL=1). The metadata range is refused regardless.
  allowLocalDestinations?: boolean;
  // The collector's own addresses for that check (default: every interface).
  ownAddresses?: () => Iterable<string>;
  // U6: the admin's interception rules, read per request (absent: none). They
  // apply only to intercepted HTTP from an allowed client, never to a
  // collector-internal endpoint or a raw TLS tunnel (see ./rules.ts).
  rules?: Pick<RulesStore, 'list'>;
  // DNS resolution for the destination checks (all addresses). Tests inject it.
  lookup?: Lookup;
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

  // The hosts a request names: mockttp's parsed destination and the URL's own
  // host. Both are checked because mockttp mis-parses a bracketed IPv6 literal in
  // `destination` (`[fd00:ec2::254]` arrives as hostname `[fd00:ec2:` port 254)
  // while still dialling the URL's host.
  type ReqLike = { remoteIpAddress?: string; destination?: { hostname: string; port: number }; url?: string };
  const hostsOf = (req: ReqLike): string[] => {
    const out: string[] = [];
    if (req.destination?.hostname) out.push(req.destination.hostname);
    try { if (req.url) out.push(new URL(req.url).hostname); } catch { /* unparsable: destination only */ }
    return out;
  };
  // The cloud metadata service in any spelling (netAddr.ts): an IPv4 numeric form,
  // IPv4-mapped / NAT64 IPv6, fd00:ec2::254, or a metadata name.
  const isMetadataDest = (req: ReqLike): boolean => hostsOf(req).some(isMetadataHost);

  // A request we should turn into evidence: from an allowed client, not to a
  // collector-internal endpoint, and not to the cloud metadata service.
  const shouldRecord = (req: ReqLike): boolean =>
    isAllowedClient(req.remoteIpAddress) && !isExcludedDest(req.destination) && !isMetadataDest(req);

  // The single access decision, shared by the HTTP gate and the WebSocket guard
  // rule so both channels reject identically: refuse a cloud-metadata fetch and any
  // client outside the allowlist, but let a collector-internal endpoint through
  // (its TLS is tunnelled raw via tlsPassthrough, and it is dropped from recording
  // in the event handlers). Returns true when the connection must be refused.
  const shouldReject = (req: ReqLike): boolean => {
    if (isMetadataDest(req)) return true;
    if (isExcludedDest(req.destination)) return false; // collector-internal: tunnel, don't reject
    return !isAllowedClient(req.remoteIpAddress);
  };
  // The HTTP/WebSocket form: also refuses a NAME that resolves into the metadata
  // range (best effort, see createMetadataResolver: mockttp dials HTTP itself).
  const resolvesToMetadata = createMetadataResolver(options.lookup);
  const shouldRejectHttp = async (req: ReqLike): Promise<boolean> => {
    if (shouldReject(req)) return true;
    if (isExcludedDest(req.destination)) return false;
    for (const h of new Set(hostsOf(req))) if (await resolvesToMetadata(h)) return true;
    return false;
  };

  // U7 + 0.3.0 review: the pre-dial gate for every relay mockttp makes itself,
  // raw streams and TLS pass-through tunnels (whatever carried them: CONNECT or
  // SOCKS). A collector-internal endpoint is tunnelled on purpose: relayed to the
  // host the device dialled, never refused, never recorded. Otherwise a client
  // outside the allowlist and a refused destination (destGuard.ts) are closed
  // before any upstream connection, and a name is dialled at its checked address.
  // A TLS tunnel to a collector host on another port is checked like any other
  // destination, and never recorded (the U5 rule).
  const rawEnabled = options.rawStreams === true;
  const allowLocal = options.allowLocalDestinations === true;
  const destGuard = createDestGuard({ allowLocal, lookup: options.lookup, ownAddresses: options.ownAddresses });
  const rawStreams = createRawStreamCapture({
    store, generation, deviceIdOf, newRecordId, normalizeIp, recordSessions: rawEnabled,
    async gate(ip, host, p, type) {
      if (isExcludedDest({ hostname: host, port: p })) return { verdict: 'skip', dialHost: host };
      if (!isAllowedClient(ip)) return { verdict: 'refuse', reason: 'client not in the allowlist' };
      const d = await destGuard.check(host);
      if (!d.ok) return { verdict: 'refuse', reason: d.reason };
      return { verdict: type === 'tls' && collectorHosts.has(host) ? 'skip' : 'record', dialHost: d.address };
    },
  });

  // Connection gate applied by the HTTP passthrough rule BEFORE upstream is
  // contacted. Rejecting here (`response: 'close'`) means a disallowed client or a
  // metadata fetch never reaches the network — the allowlist is a real boundary,
  // not just a recording filter.
  // U6: interception rules run after the gate, only on traffic it admitted and
  // that is not collector-internal (`shouldRecord`).
  const ruleRunner = createRuleRunner({
    rules: () => options.rules?.list() ?? [],
    refuseDestination: (hostname, p) => isMetadataHost(hostname) || isExcludedDest({ hostname, port: p }),
  });
  const gate = async (req: CompletedRequest) => {
    if (await shouldRejectHttp(req)) {
      log.warn('proxy: refused HTTP connection', req.destination?.hostname, normalizeIp(req.remoteIpAddress));
      return { response: 'close' as const };
    }
    return shouldRecord(req) ? ruleRunner.beforeRequest(req) : undefined;
  };
  // The entry for a finished exchange, as the rules left it: the request as sent
  // upstream (or as answered by a mock), plus the applied-rule fields.
  const ruleAware = async (req: CompletedRequest, fx: RuleEffects | undefined) => {
    const sent = fx?.sent;
    const requestBuf = sent?.body ?? (await req.body.getDecodedBuffer().catch(() => req.body.buffer)) ?? null;
    return { method: sent?.method ?? req.method, url: sent?.url ?? req.url, requestHeaders: sent?.headers ?? req.headers, requestBuf };
  };
  const withRuleFields = (e: EntryInput, fx: RuleEffects | undefined): EntryInput => {
    const mark = { hit: false };
    const fields = ruleEntryFields(fx, mark);
    return { ...e, ...fields, ...(mark.hit ? { redacted: { request: true, response: e.redacted?.response ?? false } } : {}) };
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
      // A name the gate refuses after resolving it (metadata range) is never recorded.
      if (await shouldRejectHttp(req)) { httpIds.delete(req.id); return; }
      store.touchDevice({ deviceId: ids.deviceId, platform: 'proxy', appVersion: '', buildProfile: 'proxy', dropped: 0, lastSeen: Date.now() });
      const requestBuf = await req.body.getDecodedBuffer().catch(() => req.body.buffer);
      store.addEntryInput(buildEntryInput({
        ids, startedAt: epochOf(req.timingEvents), method: req.method, url: req.url,
        requestHeaders: req.headers, requestBuf: requestBuf ?? null,
      }));
    });

    await s.on('response', async (res: CompletedResponse) => {
      const fx = ruleRunner.take(res.id);
      const pending = httpIds.get(res.id);
      if (!pending) return;
      httpIds.delete(res.id);
      const responseBuf = await res.body.getDecodedBuffer().catch(() => res.body.buffer);
      const t = res.timingEvents;
      const durationMs = t.responseSentTimestamp != null && t.startTimestamp != null ? Math.round(t.responseSentTimestamp - t.startTimestamp) : null;
      store.addEntryInput(withRuleFields(buildEntryInput({
        ids: pending.ids, startedAt: epochOf(pending.req.timingEvents), ...(await ruleAware(pending.req, fx)),
        status: res.statusCode, statusText: res.statusMessage, responseHeaders: res.headers, responseBuf: responseBuf ?? null,
        durationMs,
      }), fx));
    });

    await s.on('abort', async (req: AbortedRequest) => {
      const fx = ruleRunner.take(req.id);
      const pending = httpIds.get(req.id);
      if (!pending) return;
      httpIds.delete(req.id);
      store.addEntryInput(withRuleFields(buildEntryInput({
        ids: pending.ids, startedAt: epochOf(pending.req.timingEvents), ...(await ruleAware(pending.req, fx)),
        error: req.error?.code ? `aborted ${req.error.code}` : 'aborted',
      }), fx));
    });

    // ---- WebSocket -------------------------------------------------------
    await s.on('websocket-request', async (req: CompletedRequest) => {
      if (!shouldRecord(req)) return;
      if (await shouldRejectHttp(req)) return;
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
    // never reaches the HTTP gate above. Its access boundary is the pre-dial gate
    // (rawStreams' passthroughSocket wrapper, mandatory: start() fails without
    // it): a client outside the allowlist or a refused destination is closed
    // before mockttp dials, so these events only ever describe admitted tunnels.
    // `rawStreams.attach` is subscribed first: it restores the host name the
    // client asked for when the gate handed mockttp a resolved address.
    // Collector-internal tunnels keep their pre-U5 behaviour: never recorded.
    // A recorded tunnel is a `CONNECT` entry (no headers/bodies; nothing inside the
    // tunnel is visible) whose `tunnel` field carries host, port, SNI and, at close,
    // the client connection's byte counts. It is in flight (status null) while open
    // and gets status 200 and its duration when it closes.
    await rawStreams.attach(s);
    await s.on('tls-passthrough-opened', (e: TlsPassthroughEvent) => {
      const dest = e.destination;
      if (collectorHosts.has(dest.hostname) || isExcludedDest(dest)) return;
      const sock = clientSockets.get(sockKey(e.remoteIpAddress, e.remotePort)) ?? null;
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
    // `.always()`: without it mockttp completes the rule after its first match and
    // the passthrough below takes every later refused upgrade.
    await s.forAnyWebSocket().matching((req) => shouldRejectHttp(req)).always().thenCloseConnection();
    await s.forAnyWebSocket().thenPassThrough({ ignoreHostHttpsErrors: true });
    // U6: a request a response-phase rule matches takes the passthrough with
    // `beforeResponse` (mockttp buffers those responses); everything else keeps the
    // streaming passthrough. `.always()` keeps this rule first for every match.
    await s.forAnyRequest().matching((req) => shouldRecord(req) && ruleRunner.wantsResponse(req)).always()
      .thenPassThrough({ ignoreHostHttpsErrors: true, beforeRequest: gate, beforeResponse: (res, req) => ruleRunner.beforeResponse(res, req) });
    await s.forAnyRequest().thenPassThrough({ ignoreHostHttpsErrors: true, beforeRequest: gate });
  }

  return {
    get port() { return actualPort; },
    sessionId,
    async start() {
      if (server) return;
      const build = (raw: boolean): Mockttp => getLocal({
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
        ...(raw ? { passthrough: ['unknown-protocol' as const] } : {}),
        ...(options.socks ? { socks: true } : {}),
      });
      // Every relay mockttp dials itself (TLS tunnels always exist: the
      // collector's own hosts; raw streams when on) goes through the pre-dial
      // gate. Without it the proxy would relay ungated: refuse to start.
      server = build(rawEnabled);
      if (!rawStreams.install(server)) {
        server = null;
        throw new Error('proxy: cannot gate TLS tunnels and raw streams in this mockttp version (no passthroughSocket); refusing to start');
      }
      await server.start(port);
      actualPort = server.port;
      // Observe the client TCP sockets (first sighting wins: mockttp re-emits
      // `connection` for the same socket after a CONNECT), for the byte counts of a
      // recorded tunnel. This reaches into mockttp's listener because it exposes no
      // socket for a raw tunnel; access control does not depend on it (the gate
      // above runs before the dial).
      const raw = (server as unknown as { server?: { prependListener?: unknown } }).server;
      if (raw && typeof raw.prependListener === 'function') {
        (raw as unknown as net.Server).prependListener('connection', (sock: net.Socket) => {
          const key = sockKey(sock.remoteAddress, sock.remotePort);
          if (clientSockets.has(key)) return;
          clientSockets.set(key, sock);
          sock.once('close', () => { if (clientSockets.get(key) === sock) clientSockets.delete(key); });
        });
      } else {
        log.warn('proxy: cannot observe client connections; tunnel byte counts are unavailable');
      }
      await attach(server);
      log.info(`proxy source listening on ${options.host ?? '0.0.0.0'}:${server.port} (session ${sessionId}); allowlist ${[...allow].join(',') || '(empty)'}`);
      if (userPassthrough.length) log.info(`proxy: TLS pass-through (not intercepted): ${userPassthrough.join(', ')}`);
      if (interceptOnly.length) log.info(`proxy: TLS intercept-only (every other host is tunnelled): ${interceptOnly.join(', ')}`);
      if (options.socks) log.info('proxy: SOCKS v4/v5 accepted on the same port');
      if (rawEnabled) log.info('proxy: raw TCP/TLS streams are relayed and recorded (TERMINUS_PROXY_RAW_STREAMS=1)');
      if (allowLocal) log.warn("proxy: TERMINUS_PROXY_ALLOW_LOCAL=1: tunnels may reach this machine's loopback, link-local and own addresses");
    },
    async stop() {
      const s = server; server = null;
      httpIds.clear(); wsIds.clear(); tunnels.clear(); clientSockets.clear(); rawStreams.clear(); ruleRunner.clear();
      store.closeWsGeneration(generation);
      if (s) await s.stop();
    },
  };
}
