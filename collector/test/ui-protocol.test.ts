import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import type { Entry } from '../src/types.js';
import { entityKey, PROTOCOL_VERSION, type UiMessage, type WsFrameEvent, type FrameSummary } from '../src/uiProtocol.js';
import { applyUiMessage, emptyUiState } from '../ui/src/lib/state.js';
import { createCollectorHarness } from './fixtures/harness.js';

function makeEntry(id: string, deviceId: string): Entry {
  return {
    id, deviceId, source: 'xhr', startedAt: 1, method: 'GET', url: `https://x/${id}`,
    requestHeaders: {}, requestBody: null, requestBodySize: 0, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: {}, responseBody: null, responseBodySize: 0,
    responseBodyOmitted: null, durationMs: 1, error: null,
  };
}

// A /ui client that buffers the server's real envelopes so a test can wait for a
// specific message and fold the whole stream through the browser reducer.
class UiClient {
  ws: WebSocket;
  msgs: UiMessage[] = [];
  private rawFrames: string[] = [];
  private pending: (() => void)[] = [];
  constructor(url: string, cookie: string, origin: string) {
    this.ws = new WebSocket(url.replace('http', 'ws') + '/ui', { headers: { cookie, origin } });
    this.ws.on('message', (d) => {
      const s = d.toString();
      this.rawFrames.push(s);
      this.msgs.push(JSON.parse(s) as UiMessage);
      const p = this.pending; this.pending = []; for (const f of p) f();
    });
  }
  raw(): string[] { return this.rawFrames; }
  opened(): Promise<void> {
    return new Promise((res, rej) => { this.ws.on('open', () => res()); this.ws.on('error', rej); });
  }
  closed(): Promise<void> { return new Promise((res) => this.ws.on('close', () => res())); }
  waitFor(pred: (m: UiMessage) => boolean, timeout = 1500): Promise<UiMessage> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeout);
      const check = () => {
        const m = this.msgs.find(pred);
        if (m) { clearTimeout(t); resolve(m); } else this.pending.push(check);
      };
      check();
    });
  }
  fold() { return this.msgs.reduce(applyUiMessage, emptyUiState()); }
  close() { this.ws.close(); }
}

const upgradeUi = (base: string, headers: Record<string, string>) =>
  new Promise<boolean>((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ui', { headers });
    ws.on('open', () => { resolve(true); ws.close(); });
    ws.on('error', () => resolve(false));
    ws.on('unexpected-response', () => resolve(false));
  });

describe('retention message reducer (round 3)', () => {
  it('records retention totals so refused is distinguishable from evicted', () => {
    const s0 = emptyUiState();
    expect(s0.retention).toBeNull();
    const s1 = applyUiMessage(s0, {
      type: 'retention', retainedBodyBytes: 10, retainedMetadataBytes: 20,
      droppedEntries: 1, droppedSessions: 2, droppedFrames: 3, omittedBodies: 4, refusedSessions: 5, rejectedRecords: 6,
    });
    expect(s1.retention).toMatchObject({ droppedSessions: 2, refusedSessions: 5 });
    // A later snapshot with no retention totals keeps the prior ones.
    const s2 = applyUiMessage(s1, { type: 'snapshot', devices: [], entries: { items: [], nextCursor: null }, ws: { items: [], nextCursor: null }, retention: null, atMax: false, truncated: false, paused: false });
    expect(s2.retention).toMatchObject({ refusedSessions: 5 });
  });
});

describe('UI protocol v3', () => {
  it('advertises protocol version 3', () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });

  it('carries paused:false in a fresh server snapshot', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const c = new UiClient(h.url, cookie, h.origin);
      await c.opened();
      const snap = (await c.waitFor((m) => m.type === 'snapshot')) as Extract<UiMessage, { type: 'snapshot' }>;
      expect(snap.paused).toBe(false);
      c.close();
    } finally { await h.close(); }
  });

  it('stamps the current protocolVersion on a fresh server snapshot', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const c = new UiClient(h.url, cookie, h.origin);
      await c.opened();
      const snap = (await c.waitFor((m) => m.type === 'snapshot')) as Extract<UiMessage, { type: 'snapshot' }>;
      expect(snap.protocolVersion).toBe(PROTOCOL_VERSION);
      c.close();
    } finally { await h.close(); }
  });
});

describe('UI protocol v2 over the real server (R2)', () => {
  it('emits a flat ws_frame SUMMARY envelope with no payload, and advances the count', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const c = new UiClient(h.url, cookie, h.origin);
      await c.opened();
      await c.waitFor((m) => m.type === 'snapshot');

      h.store.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://x/ws', openedAt: 1, frames: [], closedAt: null, closeCode: null, closeReason: '' });
      h.store.appendWsFrame('w1', { ts: 2, direction: 'in', data: 'fixture-frame', size: 13, binary: false });

      const frameMsg = (await c.waitFor((m) => m.type === 'ws_frame')) as WsFrameEvent<FrameSummary>;
      // Flat envelope: wsId/deviceId beside the frame, not nested a level deeper.
      expect(frameMsg).toMatchObject({ type: 'ws_frame', wsId: 'w1', deviceId: 'd1' });
      // FrameSummary carries sequence + a BodyRef, never the payload text.
      expect(frameMsg.frame.sequence).toBe(0);
      expect((frameMsg.frame as unknown as { data?: string }).data).toBeUndefined();
      expect(frameMsg.frame.body.state).toBe('captured');
      // The payload text is NOT anywhere in the raw socket frames.
      expect(c.raw().some((s) => s.includes('fixture-frame'))).toBe(false);

      const state = c.fold();
      const session = state.ws.get(entityKey('d1', 'w1'));
      expect(session?.totalFrames).toBe(1); // count advanced once, no duplication
      expect((session as unknown as { frames?: unknown }).frames).toBeUndefined();

      // The payload is recoverable on demand from the frame-body route.
      const body = await (await fetch(`${h.url}/api/ws/d1/w1/frames/0/body`, { headers: { cookie } })).text();
      expect(body).toBe('fixture-frame');
      c.close();
    } finally { await h.close(); }
  });

  it('never ships body bytes on the socket during capture; they flow through /api only', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const c = new UiClient(h.url, cookie, h.origin);
      await c.opened();
      await c.waitFor((m) => m.type === 'snapshot');

      // A large (~900 KiB, under the 1 MiB per-body cap) response body with a
      // distinctive marker throughout.
      const marker = 'SECRET-BODY-MARKER';
      const bytes = new Uint8Array(Buffer.from(marker.repeat(Math.floor((900 * 1024) / marker.length))));
      h.store.addEntryInput({
        id: 'big', deviceId: 'd1', source: 'atlantis', startedAt: 1, method: 'POST', url: 'https://x/upload',
        requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
        status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: bytes, responseBodySize: bytes.length, responseBodyOmitted: null,
        durationMs: 1, error: null,
      });

      const delta = (await c.waitFor((m) => m.type === 'entry')) as Extract<UiMessage, { type: 'entry' }>;
      // The delta is a SUMMARY: a BodyRef with the size + hash, no body text.
      expect(delta.entry.responseBody.state).toBe('captured');
      expect(delta.entry.responseBody.size).toBe(bytes.length);
      expect(delta.entry.responseBody.sha256).toMatch(/^[0-9a-f]{64}$/);
      // The marker appears in NONE of the raw socket frames (snapshot + delta).
      expect(c.raw().some((s) => s.includes(marker))).toBe(false);

      // …but it is recoverable on demand over HTTP.
      const body = await (await fetch(`${h.url}/api/entries/d1/big/body?side=response`, { headers: { cookie } })).text();
      expect(body.startsWith(marker)).toBe(true);
      expect(body.length).toBe(bytes.length);
      c.close();
    } finally { await h.close(); }
  });

  it('keeps same-id entries from two devices distinct via composite keys', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const c = new UiClient(h.url, cookie, h.origin);
      await c.opened();
      await c.waitFor((m) => m.type === 'snapshot');

      h.store.addEntry(makeEntry('x', 'd1'));
      h.store.addEntry(makeEntry('x', 'd2'));
      await c.waitFor((m) => m.type === 'entry' && m.entry.deviceId === 'd2');

      const state = c.fold();
      expect(state.entries.size).toBe(2);
      expect(state.entries.get(entityKey('d1', 'x'))?.deviceId).toBe('d1');
      expect(state.entries.get(entityKey('d2', 'x'))?.deviceId).toBe('d2');
      c.close();
    } finally { await h.close(); }
  });

  it('clears only the named device', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const c = new UiClient(h.url, cookie, h.origin);
      await c.opened();
      await c.waitFor((m) => m.type === 'snapshot');

      h.store.addEntry(makeEntry('a', 'd1'));
      h.store.addEntry(makeEntry('b', 'd2'));
      await c.waitFor((m) => m.type === 'entry' && m.entry.deviceId === 'd2');
      h.store.clear('d1');
      await c.waitFor((m) => m.type === 'clear');

      const state = c.fold();
      expect(state.entries.has(entityKey('d1', 'a'))).toBe(false);
      expect(state.entries.has(entityKey('d2', 'b'))).toBe(true);
      c.close();
    } finally { await h.close(); }
  });

  it('gives a reconnecting session a fresh snapshot of the whole store', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      h.store.addEntry(makeEntry('a', 'd1'));

      const c1 = new UiClient(h.url, cookie, h.origin);
      await c1.opened();
      const snap1 = (await c1.waitFor((m) => m.type === 'snapshot')) as Extract<UiMessage, { type: 'snapshot' }>;
      expect(snap1.entries.items).toHaveLength(1);
      c1.close();
      await c1.closed();

      h.store.addEntry(makeEntry('b', 'd2'));
      const c2 = new UiClient(h.url, cookie, h.origin);
      await c2.opened();
      const snap2 = (await c2.waitFor((m) => m.type === 'snapshot')) as Extract<UiMessage, { type: 'snapshot' }>;
      expect(snap2.entries.items).toHaveLength(2);
      c2.close();
    } finally { await h.close(); }
  });

  it('revokes access and closes the socket on logout', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const c = new UiClient(h.url, cookie, h.origin);
      await c.opened();
      const closed = c.closed();

      const out = await fetch(h.url + '/api/session', { method: 'DELETE', headers: { cookie, origin: h.origin } });
      expect(out.status).toBe(204);
      await closed;
      expect((await fetch(h.url + '/api/entries', { headers: { cookie } })).status).toBe(401);
    } finally { await h.close(); }
  });

  it('refuses an expired session on both data routes and the /ui upgrade', async () => {
    let t = 1_000;
    const h = await createCollectorHarness({ now: () => t });
    try {
      const cookie = await h.login();
      expect((await fetch(h.url + '/api/entries', { headers: { cookie } })).status).toBe(200);

      t += 31 * 60 * 1000; // past the 30-min idle window
      expect((await fetch(h.url + '/api/entries', { headers: { cookie } })).status).toBe(401);
      expect(await upgradeUi(h.url, { cookie, origin: h.origin })).toBe(false);
    } finally { await h.close(); }
  });
});

describe('resumed sessions reach the UI (spec item 5 broadcaster)', () => {
  it('a synthesized session appears in a live ws delta and a fresh snapshot', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const c = new UiClient(h.url, cookie, h.origin);
      await c.opened();
      await c.waitFor((m) => m.type === 'snapshot');

      // An orphan frame (no prior ws_open) carrying a known device synthesizes a
      // resumed session in the store; the broadcaster must fan it out.
      h.store.appendWsFrame('w1', { ts: 5, direction: 'in', data: 'resumed-frame', size: 13, binary: false }, null, 'd1');

      const wsMsg = (await c.waitFor((m) => m.type === 'ws')) as Extract<UiMessage, { type: 'ws' }>;
      expect(wsMsg.session).toMatchObject({ wsId: 'w1', deviceId: 'd1', resumed: true });
      expect(wsMsg.session.url).toBeNull();

      // Folded through the browser reducer the session is present and marked resumed.
      const state = c.fold();
      const session = state.ws.get(entityKey('d1', 'w1'));
      expect(session?.resumed).toBe(true);
      expect(session?.url).toBeNull();

      // A newly-connecting client sees the synthesized session in its snapshot too.
      const c2 = new UiClient(h.url, cookie, h.origin);
      await c2.opened();
      const snap = (await c2.waitFor((m) => m.type === 'snapshot')) as Extract<UiMessage, { type: 'snapshot' }>;
      const snapSession = snap.ws.items.find((w) => w.wsId === 'w1');
      expect(snapSession?.resumed).toBe(true);
      expect(snapSession?.url).toBeNull();

      c.close(); c2.close();
    } finally { await h.close(); }
  });
});
