import http from 'node:http';
import type { CollectorIdentity } from './types.js';
import { log } from '../log.js';

// A dedicated plain-HTTP listener on the LAN that serves ONLY the collector's
// public certificate, for the QR pairing flow.
//
// The loopback UI server keeps its DNS-rebinding Host check and stays bound to
// 127.0.0.1, so a paired device on the LAN cannot reach it. The certificate, on
// the other hand, is presented in the clear on every TLS handshake — it is public
// — so it is served here, on the same interface as the TLS ingest (`0.0.0.0`),
// where the device can fetch it by LAN IP. The QR is the root of trust: the app
// verifies `sha256(DER)` against the `certificateSha256` in the QR before trusting
// it, so plain HTTP is only a transport for public bytes.
//
// The response carries no `deviceToken`. There is no Host check (the data is public
// and the client dials by LAN IP), no request body is read, keep-alive is disabled
// (`Connection: close`), and the socket has a short timeout so a slow or half-open
// client cannot tie up a connection.
export function createCertServer(opts: { identity: CollectorIdentity; port: number; host?: string }) {
  const { identity, port, host = '0.0.0.0' } = opts;
  const payload = JSON.stringify({
    collectorId: identity.collectorId,
    certificateDerBase64: identity.certificateDerBase64,
    certificateSha256: identity.certificateSha256,
  });
  const bytes = Buffer.byteLength(payload);

  const server = http.createServer((req, res) => {
    res.setHeader('connection', 'close');
    try {
      const method = req.method ?? 'GET';
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname !== '/api/cert') { res.writeHead(404); return res.end('not found'); }
      if (method !== 'GET' && method !== 'HEAD') { res.writeHead(405); return res.end(); }
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': bytes,
      });
      if (method === 'HEAD') return res.end();
      return res.end(payload);
    } catch (e) {
      log.warn('cert server error', String(e));
      if (!res.headersSent) res.writeHead(500);
      res.end('error');
    }
  });

  // Bound the blast radius of an unauthenticated LAN listener: cap concurrent
  // sockets, and time out a client that dawdles over headers or the whole request
  // (slowloris). Drop a connection that then goes idle for 2 s; combined with
  // Connection: close this keeps the listener from accumulating half-open sockets.
  server.maxConnections = 32;
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.on('connection', (sock) => sock.setTimeout(2000, () => sock.destroy()));

  return {
    server,
    host,
    port,
    listen: (cb?: () => void) => server.listen(port, host, cb),
    close: () => server.close(),
  };
}
