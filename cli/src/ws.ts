import { WebSocket } from 'ws';
import type { UiMessage, SnapshotMessage } from '../../collector/src/uiProtocol.js';
import type { Config } from './config.js';
import { authError, generalError, unreachableError, CliError } from './errors.js';

// The /ui WebSocket the dashboard uses. The collector's upgrade handler requires a
// valid bearer (or session) AND a loopback Origin on its own port — a browser sends
// the Origin implicitly, so here we set it explicitly. Without it the upgrade is
// dropped even with a correct token.
function open(config: Config): WebSocket {
  return new WebSocket(`ws://${config.host}:${config.port}/ui`, {
    headers: { authorization: `Bearer ${config.token}`, origin: config.origin },
  });
}

function mapUpgrade(status: number | undefined, config: Config): Error {
  if (status === 401 || status === 403) {
    return authError('authentication failed on /ui — check --token / TERMINUS_TOKEN');
  }
  if (status == null) return unreachableError(config.host, config.port);
  return generalError(`/ui upgrade -> ${status}`);
}

// Connect, wait for the initial snapshot the broadcaster sends on add, then close.
// The message handler is attached at socket creation (before `open`) because the
// server sends the snapshot immediately on upgrade — attaching it after `open` would
// race and miss the frame.
export function firstSnapshot(config: Config): Promise<SnapshotMessage> {
  return new Promise<SnapshotMessage>((resolve, reject) => {
    const ws = open(config);
    let settled = false;
    const finish = (fn: () => void): void => { if (settled) return; settled = true; fn(); };
    ws.on('message', (data) => {
      let m: UiMessage;
      try { m = JSON.parse(String(data)) as UiMessage; }
      catch { finish(() => reject(generalError('malformed frame from collector'))); ws.close(); return; }
      if (m.type === 'snapshot') { finish(() => resolve(m)); ws.close(); }
    });
    ws.once('unexpected-response', (_req, res) => { finish(() => reject(mapUpgrade(res.statusCode, config))); ws.terminate(); });
    ws.once('error', () => finish(() => reject(unreachableError(config.host, config.port))));
    ws.once('close', () => finish(() => reject(generalError('socket closed before snapshot'))));
  });
}

export type StreamOptions = {
  onMessage: (m: UiMessage) => void;
  // Called once the socket is open. The reconnecting caller uses it to announce a
  // successful reconnection (streamUi itself resolves only on a clean stop/close).
  onOpen?: () => void;
  // Abort to close the socket and resolve cleanly (Ctrl-C).
  signal?: AbortSignal;
};

// Connect and forward every frame to `onMessage` until the signal aborts (a clean,
// user-requested stop → resolve) or the socket closes on its own. The message handler
// is attached at creation so the initial snapshot is never missed. An upgrade
// rejection (auth) or transport failure rejects; an unsolicited close by the
// collector rejects with exit 3, distinct from the user's own Ctrl-C.
export function streamUi(config: Config, { onMessage, onOpen, signal }: StreamOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = open(config);
    let settled = false;
    let aborting = false;
    let opened = false;
    const succeed = (): void => { if (!settled) { settled = true; resolve(); } };
    const fail = (e: Error): void => { if (!settled) { settled = true; reject(e); } };

    if (signal) {
      if (signal.aborted) { aborting = true; try { ws.close(); } catch { /* not open yet */ } }
      else signal.addEventListener('abort', () => { aborting = true; try { ws.close(); } catch { /* already closing */ } }, { once: true });
    }
    ws.once('open', () => { opened = true; onOpen?.(); });
    ws.on('message', (data) => {
      let m: UiMessage;
      try { m = JSON.parse(String(data)) as UiMessage; }
      catch { return; } // never crash the stream on one bad frame
      onMessage(m);
    });
    ws.once('unexpected-response', (_req, res) => { fail(mapUpgrade(res.statusCode, config)); ws.terminate(); });
    // Before the socket opened, an error means we never reached the collector; after,
    // it is a mid-stream drop. Both exit 3, but the message differs.
    ws.once('error', () => fail(opened ? new CliError('connection lost', 3) : unreachableError(config.host, config.port)));
    // A close the user did not ask for (aborting === false) means the collector
    // dropped the connection — surface it as exit 3, not a clean stop.
    ws.once('close', () => (aborting ? succeed() : fail(new CliError('collector closed the connection', 3))));
  });
}
