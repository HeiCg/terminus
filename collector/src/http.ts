import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Store } from './store.js';
import type { UiAuth } from './security/uiAuth.js';
import type { PairingImport } from './security/types.js';
import { writeHar, writeJson } from './har.js';
import { createUiBroadcast } from './uiBroadcast.js';
import { VERSION } from './version.js';
import type { IngestShared } from './deviceServer.js';
import { log } from './log.js';
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain',
};
const HEARTBEAT_MS = 30_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

// Resolve a request path to a file strictly inside uiDir, or null if it escapes.
// The trailing separator check rejects sibling directories like `${uiDir}-evil`.
export function safeStaticPath(uiDir: string, pathname: string): string | null {
  const file = path.resolve(uiDir, '.' + (pathname === '/' ? '/index.html' : pathname));
  return file === uiDir || file.startsWith(uiDir + path.sep) ? file : null;
}

// The real listening port anchors Host/Origin checks so they hold under the
// ephemeral ports used in tests and by callers that pass port 0.
function listenPort(server: http.Server): string | null {
  const a = server.address() as net.AddressInfo | null;
  return a && typeof a === 'object' ? String(a.port) : null;
}

// A loopback Host on the real port; the DNS-rebinding defense for every route.
function hostAllowed(host: string | undefined, port: string | null): boolean {
  if (!host || port == null) return false;
  try {
    const u = new URL('http://' + host);
    return LOOPBACK.has(u.hostname) && (u.port || '80') === port;
  } catch { return false; }
}

type OriginState = 'absent' | 'valid' | 'invalid';
// Origin, when present, must be a loopback page on the collector's own port.
function originState(origin: string | undefined, port: string | null): OriginState {
  if (!origin) return 'absent';
  try {
    const u = new URL(origin);
    if (LOOPBACK.has(u.hostname) && (u.port || '80') === port) return 'valid';
  } catch { /* malformed */ }
  return 'invalid';
}

export function createHttpServer(
  store: Store,
  uiDir: string,
  opts: { uiAuth: UiAuth; getPairing?: () => PairingImport | null; getPairingWarning?: () => string | null; certPort?: number; ingest?: IngestShared },
) {
  const { uiAuth, getPairing, getPairingWarning, certPort, ingest } = opts;
  // Boot instant, so GET /api/status can report the collector's uptime without a
  // process-global. A server created after boot reports its own age, which is what
  // the operator asked "how long has this been serving".
  const startedAt = Date.now();
  // One broadcaster per server owns the /ui sockets: it fans out deltas with a
  // shared serialization and byte budget, and lets logout close a session's
  // sockets by id.
  const broadcast = createUiBroadcast(store);

  const server = http.createServer((req, res) => {
    try {
      const port = listenPort(server);
      if (!hostAllowed(req.headers.host, port)) { res.writeHead(421); return res.end('misdirected'); }
      const origin = originState(req.headers.origin, port);
      if (origin === 'invalid') { res.writeHead(403); return res.end('bad origin'); }

      const u = new URL(req.url ?? '/', 'http://x');
      const device = u.searchParams.get('device') ?? undefined;
      const json = (b: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      const method = req.method ?? 'GET';

      // Anonymous: liveness only, never capture data.
      if (u.pathname === '/health') {
        if (method !== 'GET') { res.writeHead(405); return res.end(); }
        return json({ status: 'ok', version: VERSION });
      }

      // Session lifecycle. Login trades an admin bearer for a cookie; logout revokes.
      if (u.pathname === '/api/session') {
        if (method === 'POST') return uiAuth.createSession(req, res);
        if (method === 'DELETE') {
          // Cookie mutation: an exact Origin is mandatory.
          if (origin !== 'valid') { res.writeHead(403); return res.end('origin required'); }
          const sid = uiAuth.revokeSession(req);
          if (sid) broadcast.closeSession(sid);
          res.writeHead(204); return res.end();
        }
        res.writeHead(405); return res.end();
      }

      // Everything touching capture data or exports requires a session or bearer.
      const dataRoute = u.pathname.startsWith('/api/') || u.pathname === '/export.har' || u.pathname === '/export.json';
      if (dataRoute) {
        const auth = uiAuth.authorize(req);
        if (!auth.ok) { res.writeHead(auth.status); return res.end(); }

        // Device pairing blob: certificate + deviceToken, copied by the authenticated
        // UI into the QA screen. Never cached; the terminal shows only the adminToken.
        if (u.pathname === '/api/pairing') {
          if (method !== 'GET') { res.writeHead(405); return res.end(); }
          const pairing = getPairing?.() ?? null;
          if (!pairing) { res.writeHead(503); return res.end('pairing unavailable'); }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          // Additive fields; older clients ignore them. `certPort` lets the UI build
          // the QR's QrPairing (the app fetches the DER from the LAN cert listener's
          // /api/cert on that port). `pairingHostWarning` is the boot drift warning
          // (null when the SAN covers a current LAN IPv4) so `terminus pair` can print
          // it. `pairing.host` is already the advertised LAN IPv4 (resolved by the
          // caller's pairingHost), not the meta hostname.
          const body: Record<string, unknown> = { ...pairing };
          if (certPort != null) body.certPort = certPort;
          body.pairingHostWarning = getPairingWarning?.() ?? null;
          return res.end(JSON.stringify(body));
        }
        // Operational status: version, uptime, pause state, connected-device count
        // and the live retention / bodies / ingest counters. Same session-or-bearer
        // auth as every other /api/* route (checked above); no capture payload
        // crosses it, only aggregate numbers. `ingest` is null when the server was
        // built without the shared ingest machinery (the metadata-only test harness).
        if (u.pathname === '/api/status') {
          if (method !== 'GET') { res.writeHead(405); return res.end(); }
          return json({
            version: VERSION,
            uptimeMs: Date.now() - startedAt,
            paused: broadcast.isPaused(),
            devices: ingest ? ingest.slots.count() : 0,
            retention: store.retentionCounters(),
            bodies: store.bodyStats(),
            ingest: ingest ? ingest.scheduler.stats() : null,
          });
        }
        // Parsed path segments for the parametric metadata/body routes below.
        // e.g. /api/entries/d1/r1/body -> ['api','entries','d1','r1','body'].
        const seg = u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
        const cursor = u.searchParams.get('cursor');
        const parseLimit = (): number | undefined => { const n = Number(u.searchParams.get('limit')); return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined; };
        // Serve one body reference: 200 with the bytes (or an empty body for an
        // absent one), 410 + reason when the body was omitted, 404 when the owning
        // record does not exist. Never materialized into a metadata DTO.
        const serveBody = (b: import('./captureDto.js').BodyBytes | null) => {
          if (!b) { res.writeHead(404); return res.end('not found'); }
          if (b.state === 'omitted') {
            res.writeHead(410, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-body-omitted': b.omitted ?? 'unknown' });
            return res.end(JSON.stringify({ omitted: b.omitted, size: b.size }));
          }
          const buf = Buffer.from(b.bytes ?? new Uint8Array(0));
          const ct = b.encoding === 'binary' ? 'application/octet-stream' : 'text/plain; charset=utf-8';
          res.writeHead(200, { 'content-type': ct, 'cache-control': 'no-store' });
          return res.end(buf);
        };

        if (seg[1] === 'entries') {
          if (method !== 'GET') { res.writeHead(405); return res.end(); }
          // /api/entries — paged summaries (identity + BodyRefs, no bodies).
          if (seg.length === 2) return json(store.entrySummaryPage(cursor, device, parseLimit()));
          // /api/entries/:device/:id — detail (headers + BodyRefs); …/body — bytes.
          if (seg.length === 4) {
            const detail = store.entryDetail(seg[2], seg[3]);
            if (!detail) { res.writeHead(404); return res.end('not found'); }
            return json(detail);
          }
          if (seg.length === 5 && seg[4] === 'body') {
            const side = u.searchParams.get('side') === 'request' ? 'request' : 'response';
            return serveBody(store.entryBody(seg[2], seg[3], side));
          }
          res.writeHead(404); return res.end('not found');
        }

        if (seg[1] === 'ws') {
          if (method !== 'GET') { res.writeHead(405); return res.end(); }
          // /api/ws — paged session summaries (frame array replaced by counts).
          if (seg.length === 2) return json(store.wsSummaryPage(cursor, device, parseLimit()));
          // /api/ws/:device/:wsId/frames?after&limit — paged frame summaries.
          if (seg.length === 5 && seg[4] === 'frames') {
            const afterRaw = u.searchParams.get('after');
            const after = afterRaw !== null && Number.isFinite(Number(afterRaw)) ? Math.floor(Number(afterRaw)) : null;
            const page = store.wsFramesPage(seg[2], seg[3], after, parseLimit());
            if (!page) { res.writeHead(404); return res.end('not found'); }
            return json(page);
          }
          // /api/ws/:device/:wsId/frames/:sequence/body — one frame's payload.
          if (seg.length === 7 && seg[4] === 'frames' && seg[6] === 'body') {
            const sequence = Number(seg[5]);
            if (!Number.isFinite(sequence)) { res.writeHead(404); return res.end('not found'); }
            return serveBody(store.frameBody(seg[2], seg[3], Math.floor(sequence)));
          }
          res.writeHead(404); return res.end('not found');
        }

        if (u.pathname === '/api/devices') { if (method !== 'GET') { res.writeHead(405); return res.end(); } return json(store.devicePage(cursor, parseLimit())); }
        if (u.pathname === '/api/clear') {
          if (method !== 'POST') { res.writeHead(405); return res.end(); }
          // A cookie-driven mutation must carry an exact Origin; a bearer CLI need not.
          if (auth.kind === 'session' && origin !== 'valid') { res.writeHead(403); return res.end('origin required'); }
          store.clear(device); return json({ ok: true });
        }
        // Pause/resume the live UI stream. Like /api/clear, a cookie-driven
        // mutation must carry an exact Origin; a bearer CLI need not. The body is a
        // tiny JSON object {"paused": bool}; anything over 1 KiB is refused (413)
        // before parsing, and a malformed or non-boolean body is a 400.
        if (u.pathname === '/api/pause') {
          if (method !== 'POST') { res.writeHead(405); return res.end(); }
          if (auth.kind === 'session' && origin !== 'valid') { res.writeHead(403); return res.end('origin required'); }
          const chunks: Buffer[] = [];
          let size = 0;
          let aborted = false;
          req.on('data', (d: Buffer) => {
            if (aborted) return;
            size += d.length;
            if (size > 1024) { aborted = true; res.writeHead(413); res.end('payload too large'); req.destroy(); }
            else chunks.push(d);
          });
          req.on('end', () => {
            if (aborted) return;
            let body: unknown;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); }
            catch { res.writeHead(400); return res.end('bad json'); }
            if (typeof body !== 'object' || body === null || typeof (body as { paused?: unknown }).paused !== 'boolean') {
              res.writeHead(400); return res.end('paused must be a boolean');
            }
            // This runs in the 'end' callback, outside the handler's outer try, so a
            // throwing broadcaster would otherwise leave the request hung. Turn any
            // failure into a logged 500 so the UI's fetch sees a 5xx and toasts it.
            try {
              broadcast.setPaused((body as { paused: boolean }).paused);
            } catch (e) {
              log.warn('pause', String(e));
              res.writeHead(500); return res.end('pause failed');
            }
            return json({ paused: broadcast.isPaused() });
          });
          return;
        }
        // Both exports stream from an immutable snapshot that holds body
        // references for the life of the download (≤30 s lease), so a concurrent
        // clear/capture cannot corrupt the stream and the export never bypasses
        // the bodies budget. The snapshot is released in the writer's finally and,
        // as a backstop, when the response socket closes (idempotent).
        const streamExport = (kind: 'har' | 'json') => {
          const snap = store.acquireExportSnapshot({ deviceId: device });
          res.on('close', () => snap.release());
          const ext = kind === 'har' ? 'har' : 'json';
          res.writeHead(200, {
            'content-type': 'application/json', 'x-content-type-options': 'nosniff',
            'content-disposition': `attachment; filename="terminus-${Date.now()}.${ext}"`,
          });
          const done = kind === 'har' ? writeHar(snap, res) : writeJson(snap, res);
          done.catch((e) => { log.warn(`export.${ext}`, String(e)); snap.release(); if (!res.headersSent) res.writeHead(500); res.destroy(); });
        };
        if (u.pathname === '/export.har') {
          if (method !== 'GET') { res.writeHead(405); return res.end(); }
          return streamExport('har');
        }
        if (u.pathname === '/export.json') {
          if (method !== 'GET') { res.writeHead(405); return res.end(); }
          return streamExport('json');
        }
        res.writeHead(404); return res.end('not found');
      }

      // Static assets carry the login screen and app shell; no capture data lives here.
      const file = safeStaticPath(uiDir, u.pathname);
      if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
        return fs.createReadStream(file).pipe(res);
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      log.warn('http handler error', String(e));
      if (!res.headersSent) res.writeHead(500);
      res.end('error');
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, sock, head) => {
    const port = listenPort(server);
    if (!hostAllowed(req.headers.host, port)) return sock.destroy();
    const u = new URL(req.url ?? '/', 'http://x'); const p = u.pathname;
    // Only the loopback UI socket lives here; device capture ingest is TLS-only on
    // the separate LAN listener.
    if (p !== '/ui') return sock.destroy();

    // WebSockets bypass SOP/CORS, so the /ui socket needs its own session +
    // exact-Origin check; the cookie rides the upgrade request.
    if (originState(req.headers.origin, port) !== 'valid') return sock.destroy();
    const auth = uiAuth.authorize(req);
    if (!auth.ok) return sock.destroy();
    const sid: string | null = auth.kind === 'session' ? auth.sid : null;

    wss.handleUpgrade(req, sock, head, (ws) => {
      markAlive(ws);
      // The broadcaster sends the snapshot, attaches the shared store listeners
      // and enforces the per-socket/session/global caps.
      broadcast.add(ws, sid);
    });
  });

  // Heartbeat: ping every socket; terminate any that missed the previous round.
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as WebSocket & { isAlive?: boolean };
      if (w.isAlive === false) { ws.terminate(); continue; }
      w.isAlive = false; try { ws.ping(); } catch { /* socket already gone */ }
    }
  }, HEARTBEAT_MS);
  beat.unref?.();
  server.on('close', () => clearInterval(beat));

  return { server, wss, close: () => { clearInterval(beat); broadcast.close(); wss.close(); server.close(); } };
}

function markAlive(ws: WebSocket): void {
  const w = ws as WebSocket & { isAlive?: boolean };
  w.isAlive = true;
  ws.on('pong', () => { w.isAlive = true; });
}
