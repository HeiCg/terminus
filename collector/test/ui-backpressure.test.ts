import { describe, it, expect } from 'vitest';
import { Store } from '../src/store.js';
import type { Entry } from '../src/types.js';
import { createUiBroadcast, type UiSocket } from '../src/uiBroadcast.js';
import type { UiMessage } from '../src/uiProtocol.js';

function makeEntry(id: string, deviceId: string, body: string | null = null): Entry {
  return {
    id, deviceId, source: 'xhr', startedAt: 1, method: 'GET', url: `https://x/${id}`,
    requestHeaders: {}, requestBody: body, requestBodySize: body ? body.length : 0, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: {}, responseBody: null, responseBodySize: 0,
    responseBodyOmitted: null, durationMs: 1, error: null,
  };
}

// A socket that records what it was sent. Write callbacks are held so a test can
// control when the bytes are "flushed": `ackImmediately` fires them at send time
// (queue drains); otherwise they wait until `flushAcks()` — or never fire, like a
// client that stopped reading, so its queued bytes climb.
class FakeSocket implements UiSocket {
  readyState = 1;
  readonly OPEN = 1;
  sent: string[] = [];
  closed = false;
  private closeCbs: (() => void)[] = [];
  private ackCbs: (() => void)[] = [];
  constructor(private ackImmediately = true) {}
  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    if (!cb) return;
    if (this.ackImmediately) cb(); else this.ackCbs.push(cb);
  }
  flushAcks(): void { const cbs = this.ackCbs; this.ackCbs = []; for (const cb of cbs) cb(); }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.readyState = 3;
    for (const cb of this.closeCbs) cb();
  }
  on(_event: 'close', cb: () => void): this { this.closeCbs.push(cb); return this; }
  last(): string { return this.sent[this.sent.length - 1]; }
}

describe('UI fanout backpressure and caps (O06)', () => {
  for (const n of [1, 4, 16]) {
    it(`serializes a delta once and delivers the same payload to ${n} clients`, () => {
      const store = new Store();
      const serialized: UiMessage[] = [];
      const broadcast = createUiBroadcast(store, { serialize: (m) => { serialized.push(m); return JSON.stringify(m); } });
      const sockets = Array.from({ length: n }, () => new FakeSocket());
      for (const s of sockets) expect(broadcast.add(s, null)).toBe(true);

      const before = serialized.length; // one snapshot serialization per client
      store.addEntry(makeEntry('e1', 'd1'));

      const deltas = serialized.slice(before).filter((m) => m.type === 'entry');
      expect(deltas).toHaveLength(1); // serialized once, shared across all clients
      const payload = sockets[0].last();
      for (const s of sockets) expect(s.last()).toBe(payload);
      broadcast.close();
    });
  }

  it('closes a client that stops reading and keeps a healthy one streaming', () => {
    const store = new Store();
    // A single delta (~1 KiB) sits well under the per-socket cap, so the slow
    // client is closed by accumulation, not by any one message.
    const broadcast = createUiBroadcast(store, { perSocketBytes: 3000, globalBytes: 1_000_000, maxMessageBytes: 1_000_000 });
    const slow = new FakeSocket(false);   // never acks: its queue only grows
    const healthy = new FakeSocket(true);
    broadcast.add(slow, null);
    broadcast.add(healthy, null);

    const body = 'x'.repeat(650);
    for (let i = 0; i < 8 && !slow.closed; i++) store.addEntry(makeEntry(`e${i}`, 'd1', body));

    expect(slow.closed).toBe(true);       // breached its per-socket budget
    expect(healthy.closed).toBe(false);   // kept up, still connected
    expect(broadcast.size()).toBe(1);
    expect(broadcast.overloaded()).toBeGreaterThan(0);

    // The healthy client keeps receiving deltas after the slow one is dropped.
    const before = healthy.sent.length;
    store.addEntry(makeEntry('after', 'd1', body));
    expect(healthy.sent.length).toBe(before + 1);
    broadcast.close();
  });

  it('attaches one shared listener set and releases it when the last socket closes', () => {
    const store = new Store();
    const broadcast = createUiBroadcast(store);
    expect(store.listenerCount('entry')).toBe(0);

    const a = new FakeSocket();
    const b = new FakeSocket();
    broadcast.add(a, null);
    broadcast.add(b, null);
    expect(store.listenerCount('entry')).toBe(1);   // one set for the whole server
    expect(store.listenerCount('wsframe')).toBe(1);

    a.close();
    expect(store.listenerCount('entry')).toBe(1);   // still one socket connected
    b.close();
    expect(store.listenerCount('entry')).toBe(0);   // released with the last socket
    expect(broadcast.size()).toBe(0);
    expect(broadcast.queuedBytes()).toBe(0);
  });

  it('returns queued bytes to zero on close, even for late-firing callbacks', () => {
    const store = new Store();
    const broadcast = createUiBroadcast(store);
    const late = new FakeSocket(false); // holds its write callbacks
    broadcast.add(late, null);
    store.addEntry(makeEntry('e0', 'd1', 'x'.repeat(500)));
    expect(broadcast.queuedBytes()).toBeGreaterThan(0); // snapshot + delta outstanding

    late.close();                       // release must neuter the pending callbacks
    expect(broadcast.queuedBytes()).toBe(0);
    late.flushAcks();                   // ws fires these (with error) after close
    expect(broadcast.queuedBytes()).toBe(0); // no double-decrement into negative
    broadcast.close();
  });

  it('enforces the per-session and global socket caps', () => {
    const store = new Store();
    const broadcast = createUiBroadcast(store);

    const perSession = Array.from({ length: 4 }, () => new FakeSocket());
    for (const s of perSession) expect(broadcast.add(s, 'sid-1')).toBe(true);
    const fifth = new FakeSocket();
    expect(broadcast.add(fifth, 'sid-1')).toBe(false); // 4 per session
    expect(fifth.closed).toBe(true);
    broadcast.close();

    const global = Array.from({ length: 16 }, () => new FakeSocket());
    for (const s of global) expect(broadcast.add(s, null)).toBe(true);
    const seventeenth = new FakeSocket();
    expect(broadcast.add(seventeenth, null)).toBe(false); // 16 global
    expect(seventeenth.closed).toBe(true);
    broadcast.close();
  });
});

const CAP = 2 * 1024 * 1024; // MAX_UI_MESSAGE_BYTES

// This suite exercises the UI fanout's own caps, not store retention. A few tests
// deliberately push a single record whose body/frame is larger than the store's
// real per-body (1 MiB) / per-WS (256 KiB) caps, to force the fanout's over-cap
// path; relaxing those caps lets the store retain the oversized payload so the
// delta is genuinely over the message cap (rather than the store correctly
// omitting it first, which would emit a retention delta instead).
// The store now rejects a record whose metadata alone exceeds 64 KiB (SPEC), so
// to reach the FANOUT's over-cap path a test must relax that ceiling too — the
// fanout marker is a separate, defence-in-depth guarantee the store cap does not
// replace. `maxRecordBytes` is relaxed alongside the per-body/per-WS caps here.
const relaxedStore = () => new Store({ limits: { perBodyBytes: 64 * 1024 * 1024, perWsMessageBytes: 64 * 1024 * 1024, maxRecordBytes: 64 * 1024 * 1024 } });

function parseLast(s: FakeSocket): UiMessage { return JSON.parse(s.last()) as UiMessage; }

describe('UI snapshot and delta stay under the message cap (O06 / CRITICAL-1)', () => {
  it('summarizes a body-heavy store so a reconnecting client still gets a fitting snapshot', () => {
    const store = new Store();
    // Bodies dominate the store, but the snapshot carries only SUMMARIES (BodyRefs),
    // so every record fits and nothing is truncated — and no body text is inlined.
    for (let i = 0; i < 6; i++) store.addEntry(makeEntry(`e${i}`, 'd1', 'x'.repeat(600 * 1024)));

    const sock = new FakeSocket();
    expect(broadcastAdd(store, sock)).toBe(true);
    const snap = parseLast(sock);
    if (snap.type !== 'snapshot') throw new Error('expected snapshot');
    expect(Buffer.byteLength(sock.last())).toBeLessThanOrEqual(CAP);
    expect(snap.truncated).toBe(false);
    expect(snap.entries.items).toHaveLength(6);
    expect(snap.entries.items.every((e) => e.requestBody.state === 'captured')).toBe(true);
    expect(sock.last().includes('x'.repeat(1000))).toBe(false); // body bytes never inlined
  });

  it('truncates newest-first with a flag when the summaries alone exceed the cap', () => {
    const store = new Store();
    // Summaries drop headers, so to overflow the snapshot we use long URLs (part of
    // the summary, bounded by maxRecordBytes): ~3 KiB each × 900 > 2 MiB.
    const longPath = 'u'.repeat(3 * 1024);
    for (let i = 0; i < 900; i++) {
      const e = makeEntry(`e${i}`, 'd1');
      e.startedAt = i; // ascending: higher i is newer
      e.url = `https://x/${i}/${longPath}`;
      store.addEntry(e);
    }
    const sock = new FakeSocket();
    broadcastAdd(store, sock);
    const snap = parseLast(sock);
    if (snap.type !== 'snapshot') throw new Error('expected snapshot');
    expect(Buffer.byteLength(sock.last())).toBeLessThanOrEqual(CAP);
    expect(snap.truncated).toBe(true);
    expect(snap.entries.items.length).toBeLessThan(900);
    const ids = new Set(snap.entries.items.map((e) => e.id));
    expect(ids.has('e899')).toBe(true);  // newest kept
    expect(ids.has('e0')).toBe(false);   // oldest dropped
  });

  it('carries a huge body as a summary BodyRef, never body bytes, well under the cap', () => {
    const store = relaxedStore();
    const broadcast = createUiBroadcast(store);
    const sock = new FakeSocket();
    broadcast.add(sock, null);

    store.addEntry(makeEntry('huge', 'd1', 'x'.repeat(CAP + 4096))); // 2 MiB+ body
    const msg = parseLast(sock);
    if (msg.type !== 'entry') throw new Error('expected entry delta');
    expect(sock.closed).toBe(false);                       // client stays connected
    expect(Buffer.byteLength(sock.last())).toBeLessThanOrEqual(CAP);
    expect(msg.entry.requestBody.state).toBe('captured');  // ref only…
    expect(msg.entry.requestBody.size).toBe(CAP + 4096);   // …with the size
    expect(msg.entry.requestBody.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sock.last().includes('x'.repeat(1000))).toBe(false); // no body bytes on the wire
    broadcast.close();
  });

  it('carries a huge ws frame as a FrameSummary BodyRef, never the payload', () => {
    const store = relaxedStore();
    const broadcast = createUiBroadcast(store);
    const sock = new FakeSocket();
    broadcast.add(sock, null);

    store.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://x/ws', openedAt: 1, frames: [], closedAt: null, closeCode: null, closeReason: '' });
    store.appendWsFrame('w1', { ts: 2, direction: 'in', data: 'x'.repeat(CAP + 4096), size: CAP + 4096, binary: false });

    const msg = parseLast(sock);
    if (msg.type !== 'ws_frame') throw new Error('expected ws_frame delta');
    expect(sock.closed).toBe(false);                       // client stays connected
    expect(Buffer.byteLength(sock.last())).toBeLessThanOrEqual(CAP);
    expect(msg.frame.body.state).toBe('captured');         // ref only, payload fetched on demand
    expect((msg.frame as unknown as { data?: unknown }).data).toBeUndefined();
    expect(msg.frame.sequence).toBe(0);
    expect(msg.wsId).toBe('w1');
    expect(sock.last().includes('x'.repeat(1000))).toBe(false);
    broadcast.close();
  });

  it('never carries headers on an entry delta, even when they are huge', () => {
    const store = relaxedStore();
    const broadcast = createUiBroadcast(store);
    const sock = new FakeSocket();
    broadcast.add(sock, null);

    const e = makeEntry('big', 'd1');
    e.requestHeaders = { blob: 'h'.repeat(CAP + 4096) }; // huge headers — never on the summary
    store.addEntry(e);

    const msg = parseLast(sock);
    if (msg.type !== 'entry') throw new Error('expected entry delta');
    expect(sock.closed).toBe(false);
    expect(Buffer.byteLength(sock.last())).toBeLessThanOrEqual(CAP);
    expect((msg.entry as unknown as { requestHeaders?: unknown }).requestHeaders).toBeUndefined();
    expect(msg.entry.id).toBe('big');                      // identity preserved
    expect(sock.last().includes('h'.repeat(1000))).toBe(false);
    broadcast.close();
  });

  it('clips a delta with an unbounded free-text field (>2 MiB URL) to identity', () => {
    const store = relaxedStore();
    const broadcast = createUiBroadcast(store);
    const sock = new FakeSocket();
    broadcast.add(sock, null);

    const e = makeEntry('big', 'd1');
    e.url = 'https://x/' + 'u'.repeat(CAP + 4096); // a single field over the cap; nothing strips it
    store.addEntry(e);

    const msg = parseLast(sock);
    if (msg.type !== 'entry') throw new Error('expected entry delta');
    expect(sock.closed).toBe(false);                       // client stays connected
    expect(Buffer.byteLength(sock.last())).toBeLessThanOrEqual(CAP);
    expect(msg.entry.identityClipped).toBe(true);          // marker present
    expect(msg.entry.url.length).toBeLessThan(2048);       // clipped
    expect(msg.entry.id).toBe('big');                      // ids/deviceId intact
    expect(msg.entry.deviceId).toBe('d1');
    broadcast.close();
  });

  it('clips an identity field itself (>2 MiB entry id), which no earlier stage strips', () => {
    const store = relaxedStore();
    const broadcast = createUiBroadcast(store);
    const sock = new FakeSocket();
    broadcast.add(sock, null);

    // Bodies, headers and free-text fields are all empty here: the only oversized
    // field is the id, which is as device-supplied and unbounded as any other.
    store.addEntry(makeEntry('i'.repeat(4 * 1024 * 1024), 'd1'));

    const msg = parseLast(sock);
    if (msg.type !== 'entry') throw new Error('expected entry delta');
    expect(sock.closed).toBe(false);
    expect(Buffer.byteLength(sock.last())).toBeLessThanOrEqual(CAP);
    expect(msg.entry.identityClipped).toBe(true);
    expect(msg.entry.id.length).toBeLessThanOrEqual(1024);
    expect(msg.entry.deviceId).toBe('d1');
    broadcast.close();
  });

  it('clips an oversized device in a delta and in the snapshot after reconnect', () => {
    const store = new Store();
    const broadcast = createUiBroadcast(store);
    const sock = new FakeSocket();
    broadcast.add(sock, null);

    // A `hello` whose appVersion alone dwarfs the cap: `device` messages carry
    // four unbounded device-supplied strings and pass no body/header stage.
    store.applyDeviceMessage('d1', { type: 'hello', deviceId: 'd1', platform: 'android',
      appVersion: 'v'.repeat(3 * 1024 * 1024), buildProfile: 'debug', dropped: 0, ts: 5 });

    const msg = parseLast(sock);
    if (msg.type !== 'device') throw new Error('expected device delta');
    expect(sock.closed).toBe(false);
    expect(Buffer.byteLength(sock.last())).toBeLessThanOrEqual(CAP);
    expect(msg.device.identityClipped).toBe(true);
    expect(msg.device.appVersion.length).toBeLessThanOrEqual(1024);
    expect(msg.device.deviceId).toBe('d1');

    // The same device must not blow the snapshot a reconnecting client gets.
    const rejoin = new FakeSocket();
    broadcast.add(rejoin, null);
    const snap = parseLast(rejoin);
    if (snap.type !== 'snapshot') throw new Error('expected snapshot');
    expect(rejoin.closed).toBe(false);
    expect(Buffer.byteLength(rejoin.last())).toBeLessThanOrEqual(CAP);
    expect(snap.devices).toHaveLength(1);
    expect(snap.devices[0].identityClipped).toBe(true);
    expect(snap.devices[0].appVersion.length).toBeLessThanOrEqual(1024);
    expect(snap.devices[0].deviceId).toBe('d1');
    broadcast.close();
  });

  it('bounds the last-resort marker carrier by construction for a pathologically large message', () => {
    const store = relaxedStore();
    // A serializer that defeats every graceful stage: it reports each shrink
    // attempt as still over the cap, so the guard must fall through to the
    // marker — whose size depends on nothing about the input.
    const huge = 'z'.repeat(3 * 1024 * 1024);
    let lies = 0;
    const broadcast = createUiBroadcast(store, {
      // The graceful clip stage reports over-cap; only the marker serializes for real
      // (fit() now has two stages: identity-clip, then the last-resort marker).
      serialize: (m) => (m.type === 'entry' && lies++ < 2 ? 'x'.repeat(CAP + 1) : JSON.stringify(m)),
    });
    const sock = new FakeSocket();
    broadcast.add(sock, null);

    const e = makeEntry(huge, huge, huge);
    e.url = huge; e.statusText = huge; e.error = huge;
    e.requestHeaders = { [huge]: huge };
    store.addEntry(e);

    const msg = parseLast(sock);
    if (msg.type !== 'entry') throw new Error('expected entry delta');
    expect(sock.closed).toBe(false);
    expect(Buffer.byteLength(sock.last())).toBeLessThanOrEqual(64 * 1024); // MARKER_MAX_BYTES
    expect(msg.entry.identityClipped).toBe(true);
    expect(msg.entry.id.length).toBeLessThanOrEqual(256);
    expect((msg.entry as unknown as { requestHeaders?: unknown }).requestHeaders).toBeUndefined();
    expect(msg.entry.requestBody.state).toBe('absent');  // reduced to an empty ref
    expect(broadcast.markered()).toBe(1);                // counted, not dropped
    broadcast.close();
  });
});

// add() with default caps; returns the add() result.
function broadcastAdd(store: Store, sock: FakeSocket): boolean {
  return createUiBroadcast(store).add(sock, null);
}

describe('removal fanout stays under the marker bound (IMPORTANT 6 / round-2 byte-bound)', () => {
  const MARKER_MAX = 64 * 1024;
  it('chunks a large entries_removed batch into multiple in-bound messages, dropping no keys', () => {
    const store = new Store();
    const broadcast = createUiBroadcast(store);
    const sock = new FakeSocket();
    broadcast.add(sock, null);
    sock.sent.length = 0; // discard the snapshot

    // A single clear removes 950 entries at once -> one store event, chunked fanout.
    for (let i = 0; i < 950; i++) store.addEntry(makeEntry(`e${String(i).padStart(4, '0')}`, 'd1'));
    store.clear('d1');

    const removals = sock.sent.map((s) => JSON.parse(s) as UiMessage).filter((m) => m.type === 'entries_removed') as Array<Extract<UiMessage, { type: 'entries_removed' }>>;
    expect(removals.length).toBeGreaterThan(1); // chunked into multiple ordered messages
    for (const s of sock.sent) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(MARKER_MAX);
    const removedIds = new Set(removals.flatMap((m) => m.keys.map((k) => k.id)));
    expect(removedIds.size).toBe(950);
    expect(sock.closed).toBe(false); // clients stay connected, no forced resync needed
    broadcast.close();
  });

  it('bounds removal chunks by BYTES even with long device-supplied ids', () => {
    const store = new Store();
    const broadcast = createUiBroadcast(store);
    const sock = new FakeSocket();
    broadcast.add(sock, null);
    sock.sent.length = 0;

    // 300 entries whose ids are 256 chars each: a fixed 400-key chunk would be
    // ~200 KiB (3x the marker bound); byte-bounded chunking keeps every message in.
    const longId = (i: number) => `x`.repeat(240) + String(i).padStart(4, '0');
    for (let i = 0; i < 300; i++) store.addEntry(makeEntry(longId(i), 'd1'));
    store.clear('d1');

    const removals = sock.sent.map((s) => JSON.parse(s) as UiMessage).filter((m) => m.type === 'entries_removed') as Array<Extract<UiMessage, { type: 'entries_removed' }>>;
    for (const s of sock.sent) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(MARKER_MAX); // each message under bound
    expect(removals.length).toBeGreaterThan(1); // byte-bounded into multiple chunks, not one over-cap message
    const ids = new Set(removals.flatMap((m) => m.keys.map((k) => k.id)));
    expect(ids.size).toBe(300); // nothing dropped
    broadcast.close();
  });

  it('sizes chunks by SERIALIZED BYTES for JSON-escape-heavy ids (control / non-BMP)', () => {
    const store = new Store();
    const broadcast = createUiBroadcast(store);
    const sock = new FakeSocket();
    broadcast.add(sock, null);
    sock.sent.length = 0;

    // Ids of control chars (each escapes to \u00XX = 6 bytes) plus a non-BMP emoji:
    // character length is a 6x under-estimate of wire bytes, so a char-count budget
    // would pack ~500 keys into one ~130 KiB message. Byte sizing keeps each chunk in.
    const ctrl = String.fromCharCode(1).repeat(40);
    const nasty = (i) => ctrl + "\u{1F600}" + String(i).padStart(4, "0");
    for (let i = 0; i < 600; i++) store.addEntry(makeEntry(nasty(i), 'd1'));
    store.clear('d1');

    const removals = sock.sent.map((s) => JSON.parse(s) as UiMessage).filter((m) => m.type === 'entries_removed') as Array<Extract<UiMessage, { type: 'entries_removed' }>>;
    // Every message stays under the marker bound (would be ~130 KiB under char sizing)…
    for (const s of sock.sent) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(MARKER_MAX);
    // …and under the message cap, and no key is dropped.
    for (const s of sock.sent) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(CAP);
    const ids = new Set(removals.flatMap((m) => m.keys.map((k) => k.id)));
    expect(ids.size).toBe(600);
    expect(sock.closed).toBe(false);
    broadcast.close();
  });
});
