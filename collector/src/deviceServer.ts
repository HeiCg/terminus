import https from 'node:https';
import type net from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { Store } from './store.js';
import type { CollectorIdentity } from './security/types.js';
import { tlsServerOptions, verifyDeviceToken, bearer } from './security/deviceAuth.js';
import { isDeviceMessage } from './types.js';
import { IngestScheduler, ByteBudget } from './ingestScheduler.js';
import { env, envName } from './env.js';
import { log } from './log.js';

// v2 WSS caps: a device message is bounded to 2 MiB by ws itself; the aggregate
// queue is bounded by the shared byte budget.
export const WSS_MAX_PAYLOAD = 2 * 1024 * 1024;
export const GLOBAL_BUDGET_BYTES = 128 * 1024 * 1024;
export const MAX_DEVICE_CONNECTIONS = 16;

// A back-pressured (read-paused) connection is given this long to drain before it is
// closed with 1013 and counted as overload — the backstop against a device that keeps
// its socket buffer full but never lets the collector catch up. Overridable via
// TERMINUS_INGEST_PAUSE_MAX_MS.
export const DEFAULT_INGEST_PAUSE_MAX_MS = 30_000;

function readPauseMaxMs(): number {
  const raw = env('INGEST_PAUSE_MAX_MS');
  if (raw == null) return DEFAULT_INGEST_PAUSE_MAX_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    log.warn(`${envName('INGEST_PAUSE_MAX_MS')} is not a positive number, using default`, DEFAULT_INGEST_PAUSE_MAX_MS);
    return DEFAULT_INGEST_PAUSE_MAX_MS;
  }
  return Math.floor(n);
}

// Device-connection slots shared across both ingests (WSS + Atlantis TLS). A 17th
// connection is refused rather than silently multiplexed.
export class ConnectionSlots {
  private n = 0;
  constructor(private readonly max = MAX_DEVICE_CONNECTIONS) {}
  tryAcquire(): boolean { if (this.n >= this.max) return false; this.n++; return true; }
  release(): void { if (this.n > 0) this.n--; }
  count(): number { return this.n; }
}

export type IngestShared = {
  scheduler: IngestScheduler;
  budget: ByteBudget;
  slots: ConnectionSlots;
};

// Build the shared ingest machinery (one per collector, threaded into both servers).
// `budgetBytes` is overridable so tests can exercise the pause/resume threshold with
// a small cap; production uses the 128 MiB default.
export function createIngestShared(budgetBytes = GLOBAL_BUDGET_BYTES): IngestShared {
  const budget = new ByteBudget(budgetBytes);
  const scheduler = new IngestScheduler({ budget });
  const slots = new ConnectionSlots();
  return { scheduler, budget, slots };
}

// Reject an upgrade with a real HTTP status line before any WebSocket handshake, so
// a mis-authenticated or over-capacity device sees 401/503 rather than a dead socket.
function refuseUpgrade(socket: NodeJS.WritableStream & { destroy(): void }, status: number, reason: string): void {
  try { socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`); } catch { /* socket gone */ }
  socket.destroy();
}

// HTTPS + WSS(`/ingest`) LAN listener. It carries no UI, `/api/*`, or export route —
// only the authenticated capture channel. The device presents its deviceToken as a
// Bearer on the upgrade; the first server frame is `{type:'ready',protocolVersion:2}`.
export type DeviceServerOpts = {
  // Absolute cap on how long a back-pressured connection may stay read-paused before
  // it is closed with 1013 (overload). Overridable for tests; production reads the env.
  pauseMaxMs?: number;
};

export function createDeviceServer(
  store: Store,
  identity: CollectorIdentity,
  shared: IngestShared = createIngestShared(),
  opts: DeviceServerOpts = {},
) {
  const { scheduler, budget, slots } = shared;
  const pauseMaxMs = opts.pauseMaxMs ?? readPauseMaxMs();
  const idleConnId = () => `wss:${identity.collectorId}:${randomUUID()}`;

  const server = https.createServer(tlsServerOptions(identity), (_req, res) => {
    // No HTTP surface on the LAN listener.
    res.writeHead(404); res.end();
  });
  // O12: no post-auth idle timeout. Keep TCP keepalive to notice a vanished Wi-Fi
  // peer, but an authenticated, idle device is never torn down for silence.
  server.on('connection', (sock: net.Socket) => { sock.setKeepAlive(true, 30_000); });

  const wss = new WebSocketServer({ noServer: true, maxPayload: WSS_MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', 'https://x');
      if (url.pathname !== '/ingest') return refuseUpgrade(socket, 404, 'Not Found');
      // Authorize before the handshake; a wrong/absent token never reaches ingest.
      if (!verifyDeviceToken(bearer(req.headers.authorization), identity.deviceToken)) {
        return refuseUpgrade(socket, 401, 'Unauthorized');
      }
      if (!slots.tryAcquire()) return refuseUpgrade(socket, 503, 'Too Many Connections');
      // The slot is acquired BEFORE the handshake. If the socket dies mid-handshake
      // the handleUpgrade callback never runs, so guard the release on the raw socket
      // too — otherwise aborted upgrades leak slots until both ingests wedge (IMPORTANT 4).
      let slotHeld = true;
      const releaseSlot = () => { if (slotHeld) { slotHeld = false; slots.release(); } };
      socket.on('close', releaseSlot);
      socket.on('error', releaseSlot);

      wss.handleUpgrade(req, socket, head, (ws) => {
        const connId = idleConnId();
        let deviceId: string | null = null;

        // Back-pressure state. When the scheduler's pending cap is full we stop reading
        // (ws.pause) and park the frames whose bytes are already reserved in the budget,
        // rather than dropping the connection. ws.pause() only stops FUTURE socket reads,
        // so a coalesced burst can still deliver a few frames synchronously after we
        // pause — those are parked too, preserving order. A drain callback re-submits the
        // parked frames once there is room and resumes reading; a connection that never
        // drains within pauseMaxMs is closed with 1013 (counted as overload).
        let paused = false;
        let closing = false; // set once we decide to tear the connection down
        let parked: Buffer[] = [];
        let pauseStart = 0;
        let pauseTimer: NodeJS.Timeout | null = null;
        const clearPauseTimer = () => { if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; } };

        // Free this connection's session-admission registry (O04) on close, and pass
        // connId as the admission generation so a reconnect gets a fresh id budget.
        // Release any parked (reserved-but-unsubmitted) bytes and undo the pause tally.
        const release = () => {
          clearPauseTimer();
          if (paused) { paused = false; scheduler.noteResume(); }
          for (const f of parked) budget.release(f.length);
          parked = [];
          releaseSlot(); scheduler.close(connId); store.closeWsGeneration(connId);
        };

        const armPauseTimer = () => {
          if (pauseTimer) return;
          pauseTimer = setTimeout(() => {
            log.warn('ingest wss: back-pressure deadline exceeded, closing', connId);
            closing = true;
            scheduler.noteOverload();
            // Resume the socket so the close handshake can complete: while paused we
            // never read, so the peer's close reply would hang and the 1013 never lands.
            try { ws.resume(); } catch { /* socket gone */ }
            ws.close(1013, 'overloaded'); // release() runs on the ws 'close' event
          }, pauseMaxMs);
          pauseTimer.unref?.();
        };

        // Re-submit parked frames in FIFO order once the scheduler signals room. Stops
        // and re-arms the drain if the pending cap fills again mid-drain; resumes reading
        // only when every parked frame has been admitted.
        const drainParked = () => {
          while (parked.length > 0) {
            const r = scheduler.submit(connId, parked[0]);
            if (r === 'accepted') { parked.shift(); continue; }
            if (r === 'closed') return; // connection gone; parked bytes freed in release()
            scheduler.onDrain(connId, drainParked); // 'overload' — still full, wait again
            return;
          }
          const waited = Date.now() - pauseStart;
          paused = false;
          clearPauseTimer();
          scheduler.noteResume();
          log.info(`ingest wss: back-pressure resumed on ${connId} after ${waited} ms`);
          try { ws.resume(); } catch { /* socket gone */ }
        };

        scheduler.registerHandler(connId, async (_id, frame) => {
          let msg: unknown;
          try { msg = JSON.parse(frame.toString('utf8')); } catch { return { ok: false, reason: 'bad_json' }; }
          if (!isDeviceMessage(msg)) return { ok: false, reason: 'not_device_message' };
          if (msg.type === 'hello') deviceId = msg.deviceId;
          if (!deviceId) return { ok: false, reason: 'before_hello' };
          // A ws_open refused for a full admission registry closes THIS connection.
          if (store.applyDeviceMessage(deviceId, msg, connId) === 'overload') {
            log.warn('ingest wss: session admission overload, closing', connId);
            ws.close(1013, 'overloaded');
            return { ok: false, reason: 'ws_admission_overload' };
          }
          return { ok: true };
        }, () => { log.warn('ingest wss: too many invalid frames, closing', connId); ws.close(1008, 'too many invalid frames'); });

        ws.on('message', (data) => {
          if (closing) return; // tearing down; drop any frames the socket flushes on resume
          const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          // The byte budget is a hard cap (framing + queued frames): a frame that cannot
          // be reserved is a different, terminal failure — close at once, no back-pressure.
          if (!budget.reserve(frame.length)) { log.warn('ingest wss: budget overload, closing', connId); return ws.close(1013, 'overloaded'); }
          // Already back-pressured: keep FIFO order by parking (bytes reserved above);
          // the drain callback will submit these before reading resumes.
          if (paused) { parked.push(frame); return; }
          const r = scheduler.submit(connId, frame);
          if (r === 'accepted') return;
          if (r === 'closed') { budget.release(frame.length); return ws.close(1013, 'overloaded'); }
          // Pending-cap overload: a legitimate burst outran the scheduler. Pause reading
          // and park the frame that did not fit instead of dropping the connection.
          paused = true;
          pauseStart = Date.now();
          parked.push(frame);
          try { ws.pause(); } catch { /* socket gone */ }
          scheduler.notePause();
          armPauseTimer();
          log.info(`ingest wss: back-pressure on ${connId} (pending ${scheduler.stats().queued})`);
          scheduler.onDrain(connId, drainParked);
        });
        ws.on('close', () => { log.info('device wss disconnected', deviceId); release(); });
        ws.on('error', (e) => { log.warn('device wss error', String(e)); release(); });
        // Ready control frame: capture may begin.
        ws.send(JSON.stringify({ type: 'ready', protocolVersion: 2 }));
      });
    } catch (e) {
      log.warn('device upgrade error', String(e));
      refuseUpgrade(socket, 400, 'Bad Request');
    }
  });

  return {
    server,
    wss,
    scheduler,
    close: () => { wss.close(); server.close(); },
  };
}
