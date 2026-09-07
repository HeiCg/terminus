import { describe, it, expect } from 'vitest';
import { Store } from '../src/store.js';
import type { Entry } from '../src/types.js';
import { createUiBroadcast, type UiSocket } from '../src/uiBroadcast.js';
import type { UiMessage, SnapshotMessage } from '../src/uiProtocol.js';
import { createCollectorHarness } from './fixtures/harness.js';

function makeEntry(id: string, deviceId: string): Entry {
  return {
    id, deviceId, source: 'xhr', startedAt: 1, method: 'GET', url: `https://x/${id}`,
    requestHeaders: {}, requestBody: null, requestBodySize: 0, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: {}, responseBody: null, responseBodySize: 0,
    responseBodyOmitted: null, durationMs: 1, error: null,
  };
}

// A socket that records the parsed messages the broadcaster hands it. Write
// callbacks fire immediately so the byte queue drains — pause is about which
// messages are emitted, not about backpressure.
class FakeSocket implements UiSocket {
  readyState = 1;
  readonly OPEN = 1;
  sent: UiMessage[] = [];
  closed = false;
  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(JSON.parse(data) as UiMessage);
    cb?.();
  }
  close(): void { this.closed = true; this.readyState = 3; }
  on(_event: 'close', _cb: () => void): this { return this; }
  types(): string[] { return this.sent.map((m) => m.type); }
}

describe('UI pause/resume broadcaster', () => {
  it('opens with paused:false in the snapshot', () => {
    const store = new Store();
    const broadcast = createUiBroadcast(store);
    const s = new FakeSocket();
    broadcast.add(s, null);
    const snap = s.sent[0] as SnapshotMessage;
    expect(snap.type).toBe('snapshot');
    expect(snap.paused).toBe(false);
    expect(broadcast.isPaused()).toBe(false);
    broadcast.close();
  });

  it('drops store deltas while paused but still records them, and announces the pause', () => {
    const store = new Store();
    const broadcast = createUiBroadcast(store);
    const s = new FakeSocket();
    broadcast.add(s, null);
    s.sent.length = 0; // discard the initial snapshot

    broadcast.setPaused(true);
    expect(broadcast.isPaused()).toBe(true);
    // The client is told the stream paused, via push() (not fanout).
    expect(s.sent).toEqual([{ type: 'paused', paused: true }]);

    s.sent.length = 0;
    store.addEntry(makeEntry('e1', 'd1'));
    // No entry delta reaches the client while paused…
    expect(s.types()).not.toContain('entry');
    expect(s.sent).toHaveLength(0);
    // …but the store kept recording it.
    expect(store.entries('d1')).toHaveLength(1);
    broadcast.close();
  });

  it('is idempotent on repeated setPaused(true)', () => {
    const store = new Store();
    const broadcast = createUiBroadcast(store);
    const s = new FakeSocket();
    broadcast.add(s, null);
    s.sent.length = 0;

    broadcast.setPaused(true);
    broadcast.setPaused(true);
    expect(s.sent).toEqual([{ type: 'paused', paused: true }]);
    broadcast.close();
  });

  it('resyncs on resume: paused:false then a fresh snapshot carrying the entry added while paused', () => {
    const store = new Store();
    const broadcast = createUiBroadcast(store);
    const s = new FakeSocket();
    broadcast.add(s, null);

    broadcast.setPaused(true);
    store.addEntry(makeEntry('e1', 'd1'));
    s.sent.length = 0;

    broadcast.setPaused(false);
    expect(broadcast.isPaused()).toBe(false);
    // Order: the resume announcement, then a full snapshot.
    expect(s.sent[0]).toEqual({ type: 'paused', paused: false });
    const snap = s.sent[1] as SnapshotMessage;
    expect(snap.type).toBe('snapshot');
    expect(snap.paused).toBe(false);
    expect(snap.entries.items.map((e) => e.id)).toContain('e1');
    broadcast.close();
  });

  it('a client that throws on send during fanout is dropped without breaking the pause for the rest', () => {
    const store = new Store();
    const broadcast = createUiBroadcast(store);
    // A socket that sends normally until armed — so it accepts its initial
    // snapshot in add() and only throws when the pause fanout reaches it, the
    // realistic case of a client torn down mid-stream.
    class ArmableSocket extends FakeSocket {
      throwOnSend = false;
      override send(data: string, cb?: (err?: Error) => void): void {
        if (this.throwOnSend) throw new Error('broken pipe');
        super.send(data, cb);
      }
    }
    // `bad` is registered first, so the fanout hits it before the healthy client;
    // its throw must not stop the loop from reaching `good`.
    const bad = new ArmableSocket();
    const good = new FakeSocket();
    broadcast.add(bad, null);
    broadcast.add(good, null);
    bad.sent.length = 0;
    good.sent.length = 0;
    bad.throwOnSend = true; // arm only now — the throw fires inside setPaused's fanout

    // setPaused fans out {paused:true}; the throwing socket must not abort it.
    expect(() => broadcast.setPaused(true)).not.toThrow();
    // The healthy client still received the announcement…
    expect(good.sent).toEqual([{ type: 'paused', paused: true }]);
    // …and the broken socket was closed and dropped from the fanout.
    expect(bad.closed).toBe(true);
    // Dropped means unregistered: a later delta does not even try to reach it.
    expect(broadcast.size()).toBe(1);
    broadcast.close();
  });

  it('resumes deltas after resync', () => {
    const store = new Store();
    const broadcast = createUiBroadcast(store);
    const s = new FakeSocket();
    broadcast.add(s, null);
    broadcast.setPaused(true);
    broadcast.setPaused(false);
    s.sent.length = 0;

    store.addEntry(makeEntry('e2', 'd1'));
    expect(s.types()).toContain('entry');
    broadcast.close();
  });
});

describe('POST /api/pause', () => {
  it('toggles pause with a bearer and returns the state', async () => {
    const h = await createCollectorHarness();
    try {
      const on = await fetch(h.url + '/api/pause', {
        method: 'POST',
        headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ paused: true }),
      });
      expect(on.status).toBe(200);
      expect(await on.json()).toEqual({ paused: true });

      const off = await fetch(h.url + '/api/pause', {
        method: 'POST',
        headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ paused: false }),
      });
      expect(off.status).toBe(200);
      expect(await off.json()).toEqual({ paused: false });
    } finally { await h.close(); }
  });

  it('rejects a cookie mutation with a missing Origin (403)', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const res = await fetch(h.url + '/api/pause', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ paused: true }),
      });
      expect(res.status).toBe(403);
    } finally { await h.close(); }
  });

  it('accepts a cookie mutation with an exact Origin', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const res = await fetch(h.url + '/api/pause', {
        method: 'POST',
        headers: { cookie, origin: h.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ paused: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ paused: true });
    } finally { await h.close(); }
  });

  it('returns 400 on a non-boolean paused field', async () => {
    const h = await createCollectorHarness();
    try {
      const res = await fetch(h.url + '/api/pause', {
        method: 'POST',
        headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ paused: 'yes' }),
      });
      expect(res.status).toBe(400);
    } finally { await h.close(); }
  });

  it('returns 400 on invalid JSON', async () => {
    const h = await createCollectorHarness();
    try {
      const res = await fetch(h.url + '/api/pause', {
        method: 'POST',
        headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' },
        body: '{not json',
      });
      expect(res.status).toBe(400);
    } finally { await h.close(); }
  });

  it('returns 413 when the body exceeds the 1 KiB cap', async () => {
    const h = await createCollectorHarness();
    try {
      const res = await fetch(h.url + '/api/pause', {
        method: 'POST',
        headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ paused: true, pad: 'x'.repeat(2048) }),
      });
      expect(res.status).toBe(413);
    } finally { await h.close(); }
  });

  it('answers 405 for a GET', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      expect((await fetch(h.url + '/api/pause', { headers: { cookie } })).status).toBe(405);
    } finally { await h.close(); }
  });
});
