import { EventBuffer } from '../eventBuffer.js';
import { probeSession } from '../api.js';
import { utf8Bytes } from '../format.js';
import { PROTOCOL_VERSION } from '../protocol.js';
import type { UiMessage } from '../protocol.js';
import type { Store } from '../state/Store.svelte.js';
import type { Session } from '../state/Session.svelte.js';

// The one place that talks to the /ui socket, and the one place side effects
// (timers, RAF, the socket itself) live under the no-reactive-effect rule.
// Deltas are staged in the EventBuffer and applied at most once per frame; when
// the queue crosses its budget (a hidden tab that stopped draining, a burst) the
// socket is closed and the backlog dropped so the next reconnect resyncs from a
// fresh snapshot rather than replaying an unbounded, partial backlog. On close
// the session is re-probed (an expired cookie lands on login) and reconnect
// waits for the tab to be visible again so a hidden tab never spins.
//
// Every ambient dependency is injected (defaulting to the real browser one) so
// the whole lifecycle is unit-testable with a fake socket, fake RAF and fake
// clock — no jsdom timing games.
export type ClientDeps = {
  store: Store;
  session: Session;
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  raf?: (cb: FrameRequestCallback) => number;
  caf?: (id: number) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  doc?: Document;
};

const RECONNECT_MS = 2000;
const CLOSE_OVERFLOW = 4000;
const CLOSE_BAD_JSON = 4001;

export class Client {
  private readonly store: Store;
  private readonly session: Session;
  private readonly url: string;
  private readonly WS: typeof WebSocket;
  private readonly raf: (cb: FrameRequestCallback) => number;
  private readonly caf: (id: number) => void;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly doc: Document;

  private readonly buffer = new EventBuffer();
  private sock: WebSocket | null = null;
  private rafId: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onVisible: (() => void) | null = null;
  private stopped = false;
  // Warn at most once per client if a snapshot reports a protocol version this
  // build does not speak — a build-skew signal, not a per-message log spew.
  private warnedProtocol = false;

  constructor(deps: ClientDeps) {
    this.store = deps.store;
    this.session = deps.session;
    this.url = deps.url ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ui`;
    this.WS = deps.WebSocketImpl ?? WebSocket;
    this.raf = deps.raf ?? ((cb) => requestAnimationFrame(cb));
    this.caf = deps.caf ?? ((id) => cancelAnimationFrame(id));
    this.setTimeoutFn = deps.setTimeout ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeout ?? clearTimeout;
    this.doc = deps.doc ?? document;
    // v3 pause deltas are folded out of the store and forwarded here.
    this.store.onPaused = (paused) => { this.session.paused = paused; };
  }

  connect(): void {
    if (this.sock && this.sock.readyState <= 1) return; // already connecting/open
    this.stopped = false;
    // A pending reconnect (armed timer or visibility listener) from an earlier
    // drop would otherwise fire open() again and orphan the socket this call
    // opens — cancel it first so connect() is idempotent against a retry window.
    this.clearReconnect();
    this.session.connection = 'connecting';
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    this.clearReconnect();
    if (this.rafId != null) { this.caf(this.rafId); this.rafId = null; }
    this.buffer.drain();
    this.session.connection = 'closed';
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      // Detach every handler BEFORE closing: a late message or the close event
      // itself must not reach a client that is tearing down (which, on logout,
      // races a store reset). With the handlers gone, a frame after disconnect is
      // dropped and no reconnect is armed.
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      sock.close();
    }
  }

  // Cancel any armed reconnect: the retry timer and the visibility listener.
  private clearReconnect(): void {
    this.clearVisible();
    if (this.timer) { this.clearTimeoutFn(this.timer); this.timer = null; }
  }

  private open(): void {
    const sock = new this.WS(this.url);
    this.sock = sock;
    sock.onmessage = (ev: MessageEvent) => {
      const data = ev.data as string;
      let msg: UiMessage;
      try { msg = JSON.parse(data) as UiMessage; }
      catch { this.buffer.drain(); sock.close(CLOSE_BAD_JSON, 'bad-json'); return; } // never crash the reader on a malformed frame
      this.buffer.push(msg, utf8Bytes(data));
      if (this.buffer.overflowed) { sock.close(CLOSE_OVERFLOW, 'overflow'); return; }
      this.schedule();
    };
    sock.onerror = () => { sock.close(); };
    sock.onclose = () => { this.handleClose(sock); };
  }

  private schedule(): void {
    if (this.rafId == null) this.rafId = this.raf(() => this.flush());
  }

  private flush(): void {
    this.rafId = null;
    if (this.stopped) { this.buffer.drain(); return; } // torn down: never apply to a reset store
    if (this.buffer.overflowed) { this.buffer.drain(); this.sock?.close(CLOSE_OVERFLOW, 'overflow'); return; }
    const batch = this.buffer.drain();
    if (batch.length === 0) return;
    for (const m of batch) {
      if (m.type === 'snapshot') {
        this.session.connection = 'open';
        this.session.reconnectAttempt = 0;
        this.session.paused = m.paused;
        // A snapshot that declares a different protocol version means the client
        // and server builds are skewed; warn once so the mismatch is visible.
        if (m.protocolVersion != null && m.protocolVersion !== PROTOCOL_VERSION && !this.warnedProtocol) {
          this.warnedProtocol = true;
          console.warn(`Terminus UI: protocol mismatch — server v${m.protocolVersion}, client v${PROTOCOL_VERSION}`);
        }
      }
    }
    this.store.apply(batch);
  }

  private handleClose(sock: WebSocket): void {
    if (sock !== this.sock) return; // a stale socket we already replaced
    if (this.rafId != null) { this.caf(this.rafId); this.rafId = null; }
    this.buffer.drain(); // never replay a partial backlog after a drop
    if (this.stopped) return;
    this.session.connection = 'reconnecting';
    this.session.reconnectAttempt++;
    void probeSession().then((ok) => {
      if (this.stopped) return;
      if (!ok) { this.session.status = 'login'; return; } // cookie expired/revoked
      if (this.doc.hidden) this.waitForVisible();
      else this.timer = this.setTimeoutFn(() => { if (!this.stopped) this.open(); }, RECONNECT_MS);
    });
  }

  // A hidden tab never drains RAF, so reconnecting into it just rebuilds a
  // backlog that immediately overflows. Wait for the tab to come back instead.
  private waitForVisible(): void {
    this.onVisible = () => {
      if (this.doc.hidden) return;
      this.clearVisible();
      if (!this.stopped) this.open();
    };
    this.doc.addEventListener('visibilitychange', this.onVisible);
  }

  private clearVisible(): void {
    if (this.onVisible) { this.doc.removeEventListener('visibilitychange', this.onVisible); this.onVisible = null; }
  }
}
