import tls from 'node:tls';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { FrameAccumulator, MAX_FRAME_V2, LEGACY_MAX_FRAME, OverloadError } from './frames.js';
import { decodeAtlantis, decodeAtlantisAsync, PREAUTH_LIMITS, V2_LIMITS, LEGACY_LIMITS, type AtlantisEvent } from './decode.js';
import { verifyDeviceToken } from '../security/deviceAuth.js';
import { tlsServerOptions } from '../security/deviceAuth.js';
import type { CollectorIdentity } from '../security/types.js';
import { createIngestShared, type IngestShared } from '../deviceServer.js';
import type { Store } from '../store.js';
import { log } from '../log.js';

// A device.model like "Google Pixel 7 (Android 14)" marks an Android client; the
// iOS fork sends no such suffix.
const platformOf = (model?: string): 'android' | 'ios' => (model && model.includes('(Android') ? 'android' : 'ios');

const PREAUTH_FRAME_MAX = 64 * 1024;
const AUTH_TIMEOUT_MS = 5_000;      // ConnectionPackage/ACK deadline
const FRAME_PROGRESS_MS = 10_000;   // a started frame must keep making progress
const READ_CHUNK = 16 * 1024;       // bound per-read reservation so backpressure is fine-grained

// Encode a v2 control frame (`ready` / `auth_error`) in the Atlantis envelope shape,
// length-prefixed like any other frame. Exclusive to authenticated TLS v2 — legacy
// fork APIs never see it.
export function encodeControlFrame(collectorId: string, control: { type: 'ready' | 'auth_error'; protocolVersion: 2 }): Buffer {
  const envelope = { id: collectorId, messageType: 'control', content: Buffer.from(JSON.stringify(control)).toString('base64'), buildVersion: 'terminus-2' };
  const payload = Buffer.from(JSON.stringify(envelope));
  const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(payload.length));
  return Buffer.concat([h, payload]);
}

// Apply one decoded Atlantis event to the store. Shared by the TLS scheduler path
// and the legacy loopback path. `generation` identifies the connection so the
// store's session-admission authority (O04) can tell a genuine reopen from a late
// frame after a clear/eviction on this same connection; the `wsCreated` per-socket
// Set is gone — the store owns that decision now.
export function applyAtlantisEvent(store: Store, ev: AtlantisEvent, generation: string): 'overload' | void {
  if (ev.kind === 'connection') {
    const platform = platformOf(ev.device?.model);
    store.touchDevice({ deviceId: ev.deviceKey, platform, appVersion: ev.appVersion ?? ev.project?.name ?? '', buildProfile: 'atlantis', dropped: 0, lastSeen: Date.now() });
    return;
  }
  if (ev.kind === 'traffic') {
    store.addEntryInput(ev.entry);
    if (ev.isWebsocket || ev.isSse) {
      // The traffic package IS the handshake for its session (via 'open'). SSE is
      // tunnelled over the same machinery, linked to its HTTP exchange by
      // httpEntryKey and detected by Content-Type (not the package name).
      const r = store.addWsSession({ wsId: ev.entry.id, deviceId: ev.entry.deviceId, source: 'atlantis', url: ev.entry.url, openedAt: ev.entry.startedAt,
        kind: ev.isSse ? 'sse' : 'websocket', httpEntryKey: ev.isSse ? { deviceId: ev.entry.deviceId, id: ev.entry.id } : null, generation, via: 'open' });
      if (r === 'overload') return 'overload';
    }
    return;
  }
  // ws message. A message whose session was never handshaked opens a PARTIAL
  // session (via 'frame'); opening is idempotent under the admission authority.
  const opened = store.addWsSession({ wsId: ev.trafficId, deviceId: ev.deviceKey, source: 'atlantis', url: ev.url, openedAt: Math.round(ev.msg.createdAt * 1000), kind: 'websocket', httpEntryKey: null, generation, via: 'frame' });
  if (opened === 'overload') return 'overload';
  if (ev.msg.messageType === 'sendCloseMessage') {
    store.closeWs(ev.trafficId, Math.round(ev.msg.createdAt * 1000), Number(ev.msg.text) || 0, '', ev.deviceKey);
  } else {
    // Binary frames keep their raw bytes (decoded once in decode.ts); text frames
    // carry their redacted string. Routed by composite (deviceId, wsId).
    store.appendWsFrame(ev.trafficId, { ts: Math.round(ev.msg.createdAt * 1000),
      direction: ev.msg.messageType.startsWith('receive') ? 'in' : 'out',
      data: ev.msg.binary ? null : ev.msg.text, size: ev.msg.size, binary: ev.msg.binary }, ev.msg.bytes, ev.deviceKey);
  }
}

export type AtlantisOpts = { identity: CollectorIdentity; shared?: IngestShared; host?: string; pauseDeadlineMs?: number; progressDeadlineMs?: number };

// Absolute cap on how long a connection may stay read-paused (backpressure). Bounds
// the reservations a parked connection holds, so a set of peers each parked mid-frame
// cannot wedge the shared budget above the resume line forever (a livelock with
// nothing left to drain). A single connection whose frame fits below the pause line
// is never paused, so this never trips it.
const DEFAULT_PAUSE_DEADLINE_MS = 30_000;

// Atlantis capture ingest over TLS. The device's existing ConnectionPackage carries
// `passcode=deviceToken`; on a match the server emits a `ready` control frame and
// begins replay, otherwise `auth_error` and closes. Traffic frames are decoded and
// applied through the shared, bounded scheduler.
export function startAtlantisServer(store: Store, port = 10909, opts: AtlantisOpts): tls.Server {
  const identity = opts.identity;
  const shared = opts.shared ?? createIngestShared();
  const { scheduler, budget, slots } = shared;
  const pauseDeadlineMs = opts.pauseDeadlineMs ?? DEFAULT_PAUSE_DEADLINE_MS;
  const progressDeadlineMs = opts.progressDeadlineMs ?? FRAME_PROGRESS_MS;

  const server = tls.createServer(tlsServerOptions(identity), (sock) => {
    if (!slots.tryAcquire()) { log.warn('atlantis: connection slots full, rejecting'); sock.destroy(); return; }
    const connId = `atlantis:${identity.collectorId}:${randomUUID()}`;
    // Start under the 64 KiB pre-auth ceiling so an unauthenticated peer cannot make
    // us reserve megabytes by merely declaring a large length (CRITICAL 1); raised to
    // the v2 8 MiB ceiling only after the token handshake succeeds.
    const acc = new FrameAccumulator(PREAUTH_FRAME_MAX, budget);
    let key = `${sock.remoteAddress}`;
    let authorized = false;
    let released = false;
    let paused = false;

    sock.setKeepAlive(true, 30_000); // O12: keepalive only, no idle-close timeout

    const authTimer = setTimeout(() => { if (!authorized) { log.warn('atlantis: auth timeout', key); sock.destroy(); } }, AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    // Partial-frame progress deadline, suspended while the server itself has paused
    // reading for backpressure.
    let progressTimer: NodeJS.Timeout | null = null;
    const clearProgress = () => { if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; } };
    const armProgress = () => {
      if (paused) return;
      clearProgress();
      progressTimer = setTimeout(() => { log.warn('atlantis: frame progress timeout', key); sock.destroy(); }, progressDeadlineMs);
      progressTimer.unref?.();
    };

    // Backpressure by read-gating: while paused we stop reading from the socket (data
    // stays in the kernel/stream buffer — no bytes dropped) and re-enter pump() once
    // there is room again. A pause is entered for two reasons: the shared byte budget
    // crossed its 75% line, or the scheduler's per-connection pending cap is full. The
    // latter is a SOFT admission limit — it throttles, it does not close the socket.
    // Only a BUDGET pause arms the pause deadline (below): it bounds the reservations a
    // parked connection holds so a livelocked set cannot wedge the shared budget. A
    // pending-cap throttle with a healthy budget holds nothing beyond a bounded queue
    // and is drained by the scheduler itself, so it is left deadline-free.
    let resumeTimer: NodeJS.Timeout | null = null;
    let pauseTimer: NodeJS.Timeout | null = null;
    let held: Buffer | null = null; // a frame taken from the accumulator but not yet admitted
    const stopResumeTimer = () => { if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; } };
    const stopPauseTimer = () => { if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; } };
    const enterPause = () => {
      if (!paused) { paused = true; clearProgress(); }
      if (!resumeTimer) { resumeTimer = setInterval(tryResume, 5); resumeTimer.unref?.(); }
      // Arm the bounded pause deadline only for budget-caused pauses; on expiry this
      // connection is closed and counted so it can no longer pin the shared budget.
      if (!pauseTimer && budget.shouldPause()) {
        pauseTimer = setTimeout(() => {
          if (paused) { log.warn('atlantis: pause deadline exceeded, closing (overload)', key); scheduler.noteOverload(); sock.destroy(); }
        }, pauseDeadlineMs);
        pauseTimer.unref?.();
      }
    };

    const release = () => {
      if (released) return; released = true;
      clearTimeout(authTimer); clearProgress(); stopResumeTimer(); stopPauseTimer();
      if (held) { budget.release(held.length); held = null; }
      slots.release(); scheduler.close(connId); store.closeWsGeneration(connId); acc.dispose();
    };

    const authError = () => {
      try { sock.write(encodeControlFrame(identity.collectorId, { type: 'auth_error', protocolVersion: 2 })); } catch { /* gone */ }
      sock.destroy();
    };

    // Process one complete frame. Returns 'stop' when the connection is torn down, or
    // 'pause' when admission is full and the frame is being held for retry.
    const handleFrame = (frame: Buffer): 'continue' | 'stop' | 'pause' => {
      if (!authorized) {
        const ev = decodeAtlantis(frame, PREAUTH_LIMITS);
        budget.release(frame.length); // handled inline, not via the scheduler
        if (!ev || ev.kind !== 'connection') { log.warn('atlantis: first frame not a ConnectionPackage', key); authError(); return 'stop'; }
        if (!verifyDeviceToken(ev.passcode, identity.deviceToken)) { log.warn('atlantis: rejected connection (bad token)', ev.deviceKey); authError(); return 'stop'; }
        authorized = true; clearTimeout(authTimer); acc.setMaxFrame(MAX_FRAME_V2);
        key = ev.deviceKey;
        applyAtlantisEvent(store, ev, connId);
        try { sock.write(encodeControlFrame(identity.collectorId, { type: 'ready', protocolVersion: 2 })); } catch { /* gone */ }
        return 'continue';
      }
      if (scheduler.submit(connId, frame) === 'overload') { held = frame; enterPause(); return 'pause'; }
      return 'continue';
    };

    // Drain complete frames, then read more, until paused or the socket is empty.
    const pump = (): void => {
      try {
        for (;;) {
          if (paused) return;
          if (acc.hasCompleteFrame()) {           // expectedLength() throws if oversize
            const frame = acc.takeFrame()!;
            const r = handleFrame(frame);
            if (r === 'stop' || r === 'pause') return;
            if (budget.shouldPause()) { enterPause(); return; }
            continue;
          }
          // hasCompleteFrame() above may have reserved concat headroom for a large
          // incomplete frame; if that pushed us over the line, pause here so the
          // reservation is bounded by the pause deadline rather than held silently.
          if (budget.shouldPause()) { enterPause(); return; }
          // Read in bounded units so one coalesced TLS read cannot reserve an
          // unbounded slice of the shared budget in a single append; backpressure then
          // engages at frame granularity.
          const chunk = (sock.read(READ_CHUNK) ?? sock.read()) as Buffer | null;
          if (chunk === null) { if (acc.bufferedBytes() > 0) armProgress(); else clearProgress(); return; }
          acc.append(chunk);
          // Engage backpressure mid-assembly too: a large incomplete frame that
          // pushes the shared budget over the pause line must stop pulling bytes,
          // not sail through. The bounded pause deadline then guards against a set of
          // peers each parked mid-frame wedging the budget forever.
          if (budget.shouldPause()) { enterPause(); return; }
        }
      } catch (e) {
        if (e instanceof OverloadError) { log.warn('atlantis: overload', key, e.message); sock.destroy(); return; }
        log.warn('atlantis: read error', key, String(e)); sock.destroy();
      }
    };

    // Retry a held frame and, once there is room and the budget has drained, resume.
    const tryResume = (): void => {
      if (!paused) { stopResumeTimer(); stopPauseTimer(); return; }
      // If a pending-cap throttle has since become budget-pressured, arm the deadline
      // now; if the budget recovered, drop it so a pure throttle stays deadline-free.
      if (budget.shouldPause()) {
        if (!pauseTimer) { pauseTimer = setTimeout(() => { if (paused) { log.warn('atlantis: pause deadline exceeded, closing (overload)', key); scheduler.noteOverload(); sock.destroy(); } }, pauseDeadlineMs); pauseTimer.unref?.(); }
      } else {
        stopPauseTimer();
      }
      if (held) {
        if (scheduler.submit(connId, held) === 'overload') return; // still full
        held = null;
      }
      if (budget.shouldPause()) return;
      paused = false; stopResumeTimer(); stopPauseTimer(); pump();
    };

    scheduler.registerHandler(connId, async (_id, frame) => {
      const ev = await decodeAtlantisAsync(frame, V2_LIMITS);
      if (!ev) return { ok: false, reason: 'undecodable' };
      // The session-admission registry is full: close THIS connection (the one
      // responsible) with an overload reason and free its registry via release().
      if (applyAtlantisEvent(store, ev, connId) === 'overload') {
        log.warn('atlantis: session admission overload, closing', key);
        scheduler.noteOverload(); sock.destroy();
        return { ok: false, reason: 'ws_admission_overload' };
      }
      return { ok: true };
    }, () => { log.warn('atlantis: too many invalid frames, closing', key); sock.destroy(); });

    log.info('atlantis client connected', key);
    sock.on('readable', pump);
    sock.on('error', (e) => log.warn('atlantis socket', key, e.message));
    sock.on('close', () => { log.info('atlantis client closed', key); release(); });
  });

  server.listen(port, opts.host ?? '0.0.0.0', () => log.info(`atlantis tls listening on ${port}`));
  return server;
}

// Opt-in plaintext loopback ingest for local testing only (TERMINUS_ALLOW_LEGACY_LOOPBACK=1),
// bound to 127.0.0.1 on a distinct port, never advertised over mDNS, retaining the
// historical 64 MiB frame ceiling. No TLS, no token — do not expose on the LAN.
export function startLegacyLoopback(store: Store, port = 10910, opts: { passcode?: string } = {}): net.Server {
  const requirePass = !!opts.passcode;
  log.warn(`legacy plaintext loopback ingest ENABLED on 127.0.0.1:${port} (opt-in; never on the LAN)`);
  const server = net.createServer((sock) => {
    const acc = new FrameAccumulator(LEGACY_MAX_FRAME);
    const generation = `legacy:${randomUUID()}`;
    let key = `${sock.remoteAddress}`;
    let authorized = !requirePass;
    sock.on('data', (chunk) => {
      let frames: Buffer[];
      try { frames = acc.push(chunk); } catch (e) { log.warn(String(e)); sock.destroy(); return; }
      for (const f of frames) {
        const ev = decodeAtlantis(f, LEGACY_LIMITS); if (!ev) { log.warn('legacy: undecodable frame'); continue; }
        key = ev.deviceKey;
        if (ev.kind === 'connection') {
          if (requirePass && ev.passcode !== opts.passcode) { log.warn('legacy: rejected connection', key); sock.destroy(); return; }
          authorized = true;
        } else if (!authorized) { continue; }
        applyAtlantisEvent(store, ev, generation);
      }
    });
    sock.on('error', (e) => log.warn('legacy socket', key, e.message));
    sock.on('close', () => { store.closeWsGeneration(generation); log.info('legacy client closed', key); });
  });
  server.listen(port, '127.0.0.1', () => log.info(`legacy loopback listening on 127.0.0.1:${port}`));
  return server;
}
