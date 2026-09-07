import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '../ws/Client.svelte.js';
import { Store } from '../state/Store.svelte.js';
import { Session } from '../state/Session.svelte.js';
import type { SnapshotMessage, EntrySummary, BodyRef } from '../protocol.js';

const bodyRef: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };

function entry(): EntrySummary {
  return {
    id: 'r1', deviceId: 'd1', source: 'atlantis', startedAt: 1, method: 'GET', url: 'https://api.test/x',
    status: 200, durationMs: 1, error: null, requestBody: bodyRef, responseBody: bodyRef,
  };
}

function snapshot(over: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    type: 'snapshot', devices: [], entries: { items: [], nextCursor: null }, ws: { items: [], nextCursor: null },
    retention: null, atMax: false, truncated: false, paused: false, ...over,
  };
}

// Minimal WebSocket double: records close calls and lets the test drive
// open/message/close deterministically.
class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closes: { code?: number; reason?: string }[] = [];
  constructor(public url: string) { FakeWS.instances.push(this); }
  send(): void {}
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.onclose?.({} as CloseEvent);
  }
  emit(data: string): void { this.onmessage?.({ data } as MessageEvent); }
}

function makeClient(over: { doc?: Partial<Document> } = {}) {
  const store = new Store();
  const session = new Session();
  let rafCb: FrameRequestCallback | null = null;
  const raf = vi.fn((cb: FrameRequestCallback) => { rafCb = cb; return 1; });
  const caf = vi.fn(() => { rafCb = null; });
  // Use the caller's doc object by reference (so a test can flip `hidden` on the
  // very object the Client holds); default to a benign visible one.
  const doc = (over.doc ?? { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as Document;
  const client = new Client({
    store, session, url: 'ws://x/ui',
    WebSocketImpl: FakeWS as unknown as typeof WebSocket, raf, caf, doc,
  });
  return { client, store, session, raf, caf, doc, flush: () => { if (rafCb) rafCb(0); } };
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 } as Response)));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Client', () => {
  it('buffers deltas and applies them in one RAF tick', () => {
    const { client, store, flush, raf } = makeClient();
    client.connect();
    const ws = FakeWS.instances[0];
    ws.emit(JSON.stringify(snapshot()));
    ws.emit(JSON.stringify({ type: 'entry', entry: entry() }));
    expect(raf).toHaveBeenCalledTimes(1);
    flush();
    expect(store.entries).toHaveLength(1);
  });

  it('marks the connection open on snapshot and pauses on a paused delta', () => {
    const { client, session, flush } = makeClient();
    client.connect();
    const ws = FakeWS.instances[0];
    ws.emit(JSON.stringify(snapshot({ paused: false })));
    flush();
    expect(session.connection).toBe('open');
    expect(session.reconnectAttempt).toBe(0);
    ws.emit(JSON.stringify({ type: 'paused', paused: true }));
    flush();
    expect(session.paused).toBe(true);
  });

  it('closes and drops the backlog when the buffer overflows', () => {
    const { client, store, flush } = makeClient();
    const applySpy = vi.spyOn(store, 'apply');
    client.connect();
    const ws = FakeWS.instances[0];
    for (let i = 0; i < 1001; i++) ws.emit(JSON.stringify({ type: 'atmax', atMax: true }));
    expect(ws.closes.some((c) => c.code === 4000)).toBe(true);
    flush();
    expect(applySpy).not.toHaveBeenCalled();
    client.disconnect();
  });

  it('reconnects after 2000 ms when the socket drops and the session is still valid', async () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    client.connect();
    FakeWS.instances[0].close(1006, 'drop');
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWS.instances.length).toBe(2);
    client.disconnect();
  });

  it('waits for visibility instead of a timer when the tab is hidden', async () => {
    const handlers: Record<string, EventListener> = {};
    const doc = {
      hidden: true,
      addEventListener: (t: string, h: EventListener) => { handlers[t] = h; },
      removeEventListener: () => {},
    };
    const { client } = makeClient({ doc: doc as unknown as Partial<Document> });
    client.connect();
    FakeWS.instances[0].close(1006, 'drop');
    // Let the async session probe resolve, then the visibility listener is armed.
    await vi.waitFor(() => expect(handlers.visibilitychange).toBeTypeOf('function'));
    (doc as { hidden: boolean }).hidden = false;
    handlers.visibilitychange(new Event('visibilitychange'));
    expect(FakeWS.instances.length).toBe(2);
    client.disconnect();
  });

  it('goes to the login screen when the session is gone after a drop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401 } as Response)));
    const { client, session } = makeClient();
    client.connect();
    FakeWS.instances[0].close(1006, 'drop');
    await vi.waitFor(() => expect(session.status).toBe('login'));
  });

  it('connect() inside the retry window cancels the pending reconnect (one live socket)', async () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    client.connect();                          // instance 0
    FakeWS.instances[0].close(1006, 'drop');   // arms the 2000 ms retry
    await vi.advanceTimersByTimeAsync(0);       // probe resolves, timer armed but not fired
    client.connect();                          // manual reconnect within the window → instance 1
    await vi.advanceTimersByTimeAsync(5000);    // the stale timer must NOT open a third socket
    expect(FakeWS.instances.length).toBe(2);
    client.disconnect();
  });

  it('closes the socket and schedules no reconnect when logout disconnects it', async () => {
    vi.useFakeTimers();
    const { client, session } = makeClient();
    session.onLogout = () => client.disconnect(); // main.ts wiring
    client.connect();
    const ws = FakeWS.instances[0];
    await session.logout();
    expect(ws.closes.length).toBeGreaterThan(0); // socket torn down
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWS.instances.length).toBe(1);      // no reconnect
  });

  it('drops a frame that arrives after disconnect (handlers detached, nothing applies)', () => {
    const { client, store, flush } = makeClient();
    const applySpy = vi.spyOn(store, 'apply');
    client.connect();
    const ws = FakeWS.instances[0];
    ws.emit(JSON.stringify(snapshot()));
    flush();
    applySpy.mockClear();

    client.disconnect();
    // A late frame on the same socket must not reach the buffer (onmessage is
    // detached) and a forced flush must apply nothing to the reset store.
    ws.emit(JSON.stringify({ type: 'entry', entry: entry() }));
    flush();
    expect(applySpy).not.toHaveBeenCalled();
    expect(store.entries).toHaveLength(0);
  });

  it('closes with 4001 and drains on a malformed frame', () => {
    const { client, store, flush } = makeClient();
    const applySpy = vi.spyOn(store, 'apply');
    client.connect();
    const ws = FakeWS.instances[0];
    ws.emit('{not json');
    expect(ws.closes.some((c) => c.code === 4001)).toBe(true);
    flush();
    expect(applySpy).not.toHaveBeenCalled();
    client.disconnect();
  });
});
