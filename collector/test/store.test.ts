import { describe, it, expect } from 'vitest';
import { Store, MAX_ENTRIES } from '../src/store.js';
import { toHar } from '../src/har.js';
const req = (id: string) => ({ type: 'request' as const, id, ts: 1000, method: 'GET', url: 'https://api.example.io/x', headers: {}, body: null, bodySize: 0, source: 'xhr' as const });
const res = (id: string) => ({ type: 'response' as const, id, ts: 1200, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: '{}', bodySize: 2, durationMs: 200 });
describe('Store', () => {
  it('correlates request and response by id', () => {
    const s = new Store();
    s.applyDeviceMessage('d1', req('d1-1'));
    expect(s.entries('d1')[0].status).toBeNull();
    s.applyDeviceMessage('d1', res('d1-1'));
    const e = s.entries('d1')[0];
    expect(e.status).toBe(200); expect(e.durationMs).toBe(200); expect(e.responseBody).toBe('{}');
  });
  it('ignores response without request', () => {
    const s = new Store(); s.applyDeviceMessage('d1', res('ghost')); expect(s.entries()).toHaveLength(0);
  });
  it('caps entries per device', () => {
    const s = new Store();
    for (let i = 0; i < MAX_ENTRIES + 10; i++) s.applyDeviceMessage('d1', req(`d1-${i}`));
    expect(s.entries('d1')).toHaveLength(MAX_ENTRIES);
    expect(s.entries('d1')[0].id).toBe('d1-10');
  });
  it('emits entry on request and on response', () => {
    const s = new Store(); const seen: string[] = [];
    s.on('entry', (e) => seen.push(`${e.id}:${e.status}`));
    s.applyDeviceMessage('d1', req('a')); s.applyDeviceMessage('d1', res('a'));
    expect(seen).toEqual(['a:null', 'a:200']);
  });
  it('tracks devices from hello', () => {
    const s = new Store();
    s.applyDeviceMessage('d1', { type: 'hello', deviceId: 'd1', platform: 'android', appVersion: '1.0', buildProfile: 'preview', dropped: 3, ts: 1 });
    expect(s.devices()[0]).toMatchObject({ deviceId: 'd1', dropped: 3 });
  });
  it('records the ingest channel on a hello', () => {
    const s = new Store();
    s.applyDeviceMessage('d1', { type: 'hello', deviceId: 'd1', platform: 'android', appVersion: '1.0', buildProfile: 'unknown', dropped: 0, ts: 100 });
    const d = s.devices()[0];
    expect(d.channels?.ingest?.lastSeenAt).toBe(100);
    expect(d.channels?.atlantis).toBeUndefined();
    expect(d.lastSeen).toBe(100);
  });
  it('merges ingest and atlantis channels on one device; lastSeen is the max', () => {
    const s = new Store();
    s.touchDevice({ deviceId: 'd1', platform: 'android', appVersion: '1', buildProfile: 'unknown', dropped: 0, lastSeen: 100 }, 'ingest');
    s.touchDevice({ deviceId: 'd1', platform: 'android', appVersion: '1', buildProfile: 'atlantis', dropped: 0, lastSeen: 250 }, 'atlantis');
    let d = s.devices()[0];
    expect(d.channels?.ingest?.lastSeenAt).toBe(100);
    expect(d.channels?.atlantis?.lastSeenAt).toBe(250);
    expect(d.lastSeen).toBe(250);
    // A later ingest touch with an OLDER timestamp keeps lastSeen at the max.
    s.touchDevice({ deviceId: 'd1', platform: 'android', appVersion: '1', buildProfile: 'unknown', dropped: 0, lastSeen: 180 }, 'ingest');
    d = s.devices()[0];
    expect(d.channels?.ingest?.lastSeenAt).toBe(180);
    expect(d.lastSeen).toBe(250);
  });
  it('keeps a real buildProfile over channel placeholders, whatever the order', () => {
    const helloUnknown = { type: 'hello' as const, deviceId: 'd1', platform: 'android', appVersion: '3.4.1', buildProfile: 'unknown', dropped: 0, ts: 100 };
    const helloPreview = { ...helloUnknown, buildProfile: 'preview', ts: 300 };
    const atlantis = { deviceId: 'd1', platform: 'android', appVersion: '', buildProfile: 'atlantis', dropped: 0, lastSeen: 200 };

    // hello(unknown) -> atlantis -> hello(preview): ends on the real 'preview'.
    const a = new Store();
    a.applyDeviceMessage('d1', helloUnknown);
    a.touchDevice(atlantis, 'atlantis');
    a.applyDeviceMessage('d1', helloPreview);
    expect(a.devices()[0].buildProfile).toBe('preview');
    // The empty atlantis appVersion never overwrote the hello's real one.
    expect(a.devices()[0].appVersion).toBe('3.4.1');

    // atlantis-first -> hello(preview): still ends on 'preview'.
    const b = new Store();
    b.touchDevice(atlantis, 'atlantis');
    b.applyDeviceMessage('d1', helloPreview);
    expect(b.devices()[0].buildProfile).toBe('preview');

    // A later placeholder touch does NOT clobber the real value.
    b.touchDevice(atlantis, 'atlantis');
    expect(b.devices()[0].buildProfile).toBe('preview');
  });
  it('touchDevice without a channel preserves existing channels', () => {
    const s = new Store();
    s.touchDevice({ deviceId: 'd1', platform: 'android', appVersion: '1', buildProfile: 'unknown', dropped: 0, lastSeen: 100 }, 'ingest');
    s.touchDevice({ deviceId: 'd1', platform: 'proxy', appVersion: '', buildProfile: 'proxy', dropped: 0, lastSeen: 200 });
    expect(s.devices()[0].channels?.ingest?.lastSeenAt).toBe(100);
  });
  it('clear(deviceId) keeps other devices correlatable (B3)', () => {
    const s = new Store();
    s.applyDeviceMessage('d1', req('d1-1'));
    s.applyDeviceMessage('d2', req('d2-1'));
    s.clear('d1');
    expect(s.entries('d1')).toHaveLength(0);
    s.applyDeviceMessage('d2', res('d2-1'));
    expect(s.entries('d2')[0].status).toBe(200);
  });
  it('clear(deviceId) drops that device ws sessions only (B3)', () => {
    const s = new Store();
    s.applyDeviceMessage('d1', { type: 'ws_open', wsId: 'w1', ts: 1, url: 'wss://x', protocols: [] });
    s.applyDeviceMessage('d2', { type: 'ws_open', wsId: 'w2', ts: 1, url: 'wss://y', protocols: [] });
    s.clear('d1');
    s.applyDeviceMessage('d2', { type: 'ws_frame', wsId: 'w2', ts: 2, direction: 'in', data: 'hi', size: 2, binary: false });
    expect(s.wsSessions('d2')[0].frames).toHaveLength(1);
  });
  it('addEntry upserts by id (I6)', () => {
    const s = new Store();
    s.applyDeviceMessage('d1', req('dup'));
    s.applyDeviceMessage('d1', req('dup'));
    expect(s.entries('d1')).toHaveLength(1);
  });
  it('entries() without device sorts globally by startedAt (N8)', () => {
    const s = new Store();
    s.applyDeviceMessage('d1', { ...req('d1-1'), ts: 300 });
    s.applyDeviceMessage('d2', { ...req('d2-1'), ts: 100 });
    s.applyDeviceMessage('d1', { ...req('d1-2'), ts: 200 });
    expect(s.entries().map((e) => e.startedAt)).toEqual([100, 200, 300]);
  });
  it('emits an incremental ws_frame SUMMARY (no payload) instead of a full session (I7/T09)', () => {
    const s = new Store();
    const frames: { wsId: string; deviceId: string; frame: Record<string, unknown> }[] = [];
    let sessions = 0;
    s.on('wsframe', (p) => frames.push(p as never)); s.on('ws', () => sessions++);
    s.applyDeviceMessage('d1', { type: 'ws_open', wsId: 'w1', ts: 1, url: 'wss://x', protocols: [] });
    s.applyDeviceMessage('d1', { type: 'ws_frame', wsId: 'w1', ts: 2, direction: 'in', data: 'hi', size: 2, binary: false });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ wsId: 'w1', deviceId: 'd1' });
    const f = frames[0].frame;
    // FrameSummary: sequence + metadata + BodyRef; the payload is NOT on the wire.
    expect(f).toMatchObject({ sequence: 0, ts: 2, direction: 'in', binary: false });
    expect(f.data).toBeUndefined();
    expect((f.body as { state: string; size: number }).state).toBe('captured');
    expect((f.body as { size: number }).size).toBe(2);
    expect(sessions).toBe(1); // only the open, not the frame
  });

  it('emits POST-eviction retention counts on each ws_frame delta (T09 r2)', () => {
    const s = new Store({ limits: { wsMessagesPerSession: 3 } });
    const counts: { r: number; t: number; d: number }[] = [];
    s.on('wsframe', (p) => { const e = p as { retainedFrames: number; totalFrames: number; droppedFrames: number }; counts.push({ r: e.retainedFrames, t: e.totalFrames, d: e.droppedFrames }); });
    s.applyDeviceMessage('d1', { type: 'ws_open', wsId: 'w1', ts: 0, url: 'wss://x', protocols: [] });
    for (let i = 0; i < 5; i++) s.applyDeviceMessage('d1', { type: 'ws_frame', wsId: 'w1', ts: i, direction: 'in', data: `f${i}`, size: 2, binary: false });
    // Cap of 3: the 4th and 5th appends evict the oldest, and every delta reflects
    // the count AFTER that eviction — never a pre-eviction over-count. This pins
    // the store side of the "no upward drift" invariant the client relies on.
    expect(counts).toEqual([
      { r: 1, t: 1, d: 0 },
      { r: 2, t: 2, d: 0 },
      { r: 3, t: 3, d: 0 },
      { r: 3, t: 4, d: 1 },
      { r: 3, t: 5, d: 2 },
    ]);
    // The store's retained count never exceeds the cap.
    expect(s.wsSessions('d1')[0].frames).toHaveLength(3);
  });
  it('flags and emits when a device hits MAX_ENTRIES (D2)', () => {
    const s = new Store(); let flagged = false;
    s.on('atmax', () => { flagged = true; });
    expect(s.atMax()).toBe(false);
    for (let i = 0; i < MAX_ENTRIES + 1; i++) s.applyDeviceMessage('d1', req(`d1-${i}`));
    expect(s.atMax()).toBe(true);
    expect(flagged).toBe(true);
  });
  it('groups ws frames by wsId', () => {
    const s = new Store();
    s.applyDeviceMessage('d1', { type: 'ws_open', wsId: 'w1', ts: 1, url: 'wss://x', protocols: [] });
    s.applyDeviceMessage('d1', { type: 'ws_frame', wsId: 'w1', ts: 2, direction: 'in', data: 'hi', size: 2, binary: false });
    s.applyDeviceMessage('d1', { type: 'ws_close', wsId: 'w1', ts: 3, code: 1000, reason: '' });
    const w = s.wsSessions('d1')[0];
    expect(w.frames).toHaveLength(1); expect(w.closeCode).toBe(1000);
  });
});

// The WSS/JS (device-message) ingest path must apply the SAME collector-side
// redaction the Atlantis and proxy paths do, BEFORE the bytes are hashed and
// stored — so a token in a URL query, a sensitive header, or a secret in a body
// never lands in the BodyStore or in a HAR export in the clear.
describe('WSS/JS ingest path redaction (uniform posture, IMPORTANT)', () => {
  it('redacts request/response url, headers and body — in the store AND the HAR export', () => {
    const s = new Store();
    s.applyDeviceMessage('d1', {
      type: 'request', id: 'r1', ts: 1000, method: 'POST',
      url: 'https://api.example.io/x?access_token=SEKRIT&keep=1',
      headers: { authorization: 'Bearer abc', 'x-safe': 'ok' },
      body: '{"access_token":"SEKRIT","user":"neo"}', bodySize: 38, source: 'xhr',
    });
    s.applyDeviceMessage('d1', {
      type: 'response', id: 'r1', ts: 1200, status: 200, statusText: 'OK',
      headers: { 'set-cookie': 'sid=xyz', 'content-type': 'application/json' },
      body: '{"uid":"neo@example.com","ok":true}', bodySize: 35, durationMs: 200,
    });

    const e = s.entries('d1')[0];
    // URL query, headers and body are redacted at the store boundary.
    expect(e.url).toBe('https://api.example.io/x?access_token=***&keep=1');
    expect(e.requestHeaders.authorization).toBe('***');
    expect(e.requestHeaders['x-safe']).toBe('ok');
    expect(e.requestBody).toContain('"access_token":"***"');
    expect(e.requestBody).toContain('"user":"neo"');
    expect(e.responseHeaders['set-cookie']).toBe('***');
    expect(e.responseBody).toContain('"uid":"***"');
    // No secret survives anywhere in the stored bodies.
    expect(e.requestBody).not.toContain('SEKRIT');
    expect(e.responseBody).not.toContain('neo@example.com');

    // The HAR export carries the SAME redacted bytes (the BodyStore hash is of the
    // redacted body, so the export can only reproduce the redacted text).
    const h = toHar(s.entries('d1')).log.entries[0];
    expect(h.request.url).toBe('https://api.example.io/x?access_token=***&keep=1');
    expect(h.request.headers.find((x) => x.name === 'authorization')?.value).toBe('***');
    expect(h.request.postData?.text).toContain('"access_token":"***"');
    expect(h.request.postData?.text).not.toContain('SEKRIT');
    expect(h.response.content.text).toContain('"uid":"***"');
    expect(h.response.content.text).not.toContain('neo@example.com');
  });

  it('redacts ws_open url and ws_frame text before the frame is stored', () => {
    const s = new Store();
    s.applyDeviceMessage('d1', {
      type: 'ws_open', wsId: 'w1', ts: 1,
      url: 'wss://api.example.io/cable?access_token=SEK', protocols: [],
    });
    s.applyDeviceMessage('d1', {
      type: 'ws_frame', wsId: 'w1', ts: 2, direction: 'out',
      data: '{"access_token":"SEK","cmd":"subscribe"}', size: 40, binary: false,
    });
    const w = s.wsSessions('d1')[0];
    expect(w.url).toBe('wss://api.example.io/cable?access_token=***');
    expect(w.frames[0].data).toContain('"access_token":"***"');
    expect(w.frames[0].data).toContain('"cmd":"subscribe"');
    expect(w.frames[0].data).not.toContain('"SEK"');
    // Frame metadata size matches the redacted bytes (as the proxy/Atlantis paths do).
    const stored = s.frameBody('d1', 'w1', 0)!;
    expect(stored.state).toBe('captured');
    expect(Buffer.from(stored.bytes!).toString('utf8')).not.toContain('"SEK"');
  });

  it('does not double-redact: a body with no secrets is stored verbatim', () => {
    const s = new Store();
    s.applyDeviceMessage('d1', {
      type: 'request', id: 'clean', ts: 1, method: 'GET',
      url: 'https://api.example.io/x?keep=1', headers: { 'x-safe': 'ok' },
      body: '{"user":"neo","count":3}', bodySize: 24, source: 'xhr',
    });
    const e = s.entries('d1')[0];
    expect(e.url).toBe('https://api.example.io/x?keep=1');
    expect(e.requestHeaders['x-safe']).toBe('ok');
    expect(e.requestBody).toBe('{"user":"neo","count":3}');
  });
});

// Item 2: an over-cap binary WS frame loses its bytes at decode (bytes==null) but
// must report the SIZE omission reason, not fall back to 'binary'. A normal binary
// frame (bytes present, under cap) still reports its binary nature.
describe('over-cap binary WS frame reports the size-omission reason', () => {
  it('marks an over-256-KiB binary frame omitted:size, a normal binary frame captured', () => {
    const s = new Store(); // default spec caps: 256 KiB per WS message
    s.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'atlantis', url: 'wss://x', openedAt: 1 });
    // Normal binary frame: bytes present, under cap -> captured (recoverable) binary.
    s.appendWsFrame('w1', { ts: 1, direction: 'in', data: null, size: 4, binary: true }, new Uint8Array([0, 1, 2, 0xff]), 'd1');
    // Over-cap binary frame: decode dropped the bytes (null) but size is over cap.
    s.appendWsFrame('w1', { ts: 2, direction: 'out', data: null, size: 256 * 1024 + 1, binary: true }, null, 'd1');

    const normal = s.frameBody('d1', 'w1', 0)!;
    expect(normal.state).toBe('captured');
    const over = s.frameBody('d1', 'w1', 1)!;
    expect(over.state).toBe('omitted');
    expect(over.omitted).toBe('size');
    expect(over.size).toBe(256 * 1024 + 1);
  });
});

describe('Store device aliasing', () => {
  const entryInput = (deviceId: string, id: string) => ({
    id, deviceId, source: 'atlantis' as const, startedAt: 1, method: 'GET', url: 'https://x/',
    requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
    status: 200, statusText: '', responseHeaders: {}, responseBytes: null, responseBodySize: 0,
    responseBodyOmitted: null, durationMs: 1, error: null,
  });

  it('attributes atlantis traffic under the alias key to the primary device', () => {
    const s = new Store();
    // App hello on ingest declares its deviceId AND the key the SDK will present under.
    s.applyDeviceMessage('app-1', { type: 'hello', deviceId: 'app-1', platform: 'android', appVersion: '1', buildProfile: 'unknown', dropped: 0, ts: 100, atlantisDeviceKey: 'com.acme_moto g34' });
    // Atlantis connection + traffic arrive under the SDK's own envelope key.
    s.touchDevice({ deviceId: 'com.acme_moto g34', platform: 'android', appVersion: '1', buildProfile: 'atlantis', dropped: 0, lastSeen: 200 }, 'atlantis');
    s.addEntryInput(entryInput('com.acme_moto g34', 't1'));
    // Traffic landed on the primary device, not under the alias key.
    expect(s.entries('app-1')).toHaveLength(1);
    expect(s.entries('com.acme_moto g34')).toHaveLength(0);
    // Devices list shows one device carrying both channels.
    expect(s.devices()).toHaveLength(1);
    const d = s.devices()[0];
    expect(d.deviceId).toBe('app-1');
    expect(d.channels?.ingest?.lastSeenAt).toBe(100);
    expect(d.channels?.atlantis?.lastSeenAt).toBe(200);
  });

  it('routes atlantis ws sessions and frames under the alias to the primary device', () => {
    const s = new Store();
    s.applyDeviceMessage('app-1', { type: 'hello', deviceId: 'app-1', platform: 'android', appVersion: '1', buildProfile: 'unknown', dropped: 0, ts: 100, atlantisDeviceKey: 'sdk-key' });
    s.addWsSession({ wsId: 'w1', deviceId: 'sdk-key', source: 'atlantis', url: 'wss://x', openedAt: 1, generation: 'g', via: 'open' });
    s.appendWsFrame('w1', { ts: 2, direction: 'in', data: 'hi', size: 2, binary: false }, null, 'sdk-key');
    expect(s.wsSessions('app-1')).toHaveLength(1);
    expect(s.wsSessions('app-1')[0].frames).toHaveLength(1);
    expect(s.wsSessions('sdk-key')).toHaveLength(0);
  });

  it('on conflict (alias key already a device with entries) keeps both devices', () => {
    const s = new Store();
    // Atlantis connected FIRST under its own key: a real device with captured entries.
    s.touchDevice({ deviceId: 'sdk-key', platform: 'android', appVersion: '1', buildProfile: 'atlantis', dropped: 0, lastSeen: 50 }, 'atlantis');
    s.addEntryInput(entryInput('sdk-key', 't0'));
    // A later hello tries to alias that key -> refused, both devices kept.
    s.applyDeviceMessage('app-1', { type: 'hello', deviceId: 'app-1', platform: 'android', appVersion: '1', buildProfile: 'unknown', dropped: 0, ts: 100, atlantisDeviceKey: 'sdk-key' });
    // New atlantis traffic still lands under the SDK key (not rehomed).
    s.addEntryInput(entryInput('sdk-key', 't1'));
    expect(s.entries('sdk-key')).toHaveLength(2);
    expect(s.entries('app-1')).toHaveLength(0);
    expect(s.devices().map((d) => d.deviceId).sort()).toEqual(['app-1', 'sdk-key']);
  });
});

// Orphan WS frames after a collector restart: a frame whose ws_open predates this
// collector arrives with a known deviceId but no session. Rather than silently
// dropping it (data loss visible only in a counter), the store synthesizes a
// resumed session with a null url, appends the frame, and back-fills the url when
// a late ws_open arrives.
describe('Store resumed WS sessions (orphan frames after a restart)', () => {
  const frame = (over: Partial<{ ts: number; direction: 'in' | 'out'; data: string | null; size: number; binary: boolean }> = {}) =>
    ({ ts: 1, direction: 'in' as const, data: 'hi', size: 2, binary: false, ...over });

  it('synthesizes a resumed session from an orphan frame carrying a deviceId', () => {
    const s = new Store();
    const events: unknown[] = [];
    s.on('ws', (w) => events.push(w));
    s.appendWsFrame('w1', frame({ ts: 10 }), null, 'd1');

    const sessions = s.wsSessions('d1');
    expect(sessions).toHaveLength(1);
    const ws = sessions[0];
    expect(ws.wsId).toBe('w1');
    expect(ws.url).toBeNull();
    expect(ws.kind).toBe('websocket');
    expect(ws.openedAt).toBe(10);
    expect(ws.resumed).toBe(true);
    expect(ws.frames).toHaveLength(1);
    expect(ws.frames[0].data).toBe('hi');
    // The frame was NOT dropped, and the synthesis emitted a `ws` store event.
    expect(s.retentionCounters().droppedFrames).toBe(0);
    expect(events).toHaveLength(1);
  });

  it('back-fills url/kind and clears resumed when a late ws_open arrives (via applyDeviceMessage)', () => {
    const s = new Store();
    s.appendWsFrame('w1', frame({ ts: 10 }), null, 'd1');
    expect(s.wsSessions('d1')[0].resumed).toBe(true);

    const events: unknown[] = [];
    s.on('ws', (w) => events.push(w));
    // The app replays ws_open (resumed) for the still-open socket on a new generation.
    s.applyDeviceMessage('d1', { type: 'ws_open', wsId: 'w1', ts: 5, url: 'wss://api.example.io/live', protocols: [], resumed: true }, 'gen-2');

    const sessions = s.wsSessions('d1');
    expect(sessions).toHaveLength(1); // no new session
    const ws = sessions[0];
    expect(ws.url).toBe('wss://api.example.io/live');
    expect(ws.resumed).toBeUndefined();
    expect(ws.frames).toHaveLength(1); // frames preserved
    expect(events).toHaveLength(1); // back-fill emits a ws update
  });

  it('a resumed ws_open for an already-known real session is a no-op (no duplicate, no frame reset)', () => {
    const s = new Store();
    s.applyDeviceMessage('d1', { type: 'ws_open', wsId: 'w1', ts: 1, url: 'wss://api.example.io/live', protocols: [] }, 'gen-1');
    s.appendWsFrame('w1', frame({ ts: 2 }), null, 'd1');
    s.appendWsFrame('w1', frame({ ts: 3, data: 'yo' }), null, 'd1');
    expect(s.wsSessions('d1')[0].frames).toHaveLength(2);

    // A replayed ws_open on a new generation must not duplicate the session or reset frames.
    s.applyDeviceMessage('d1', { type: 'ws_open', wsId: 'w1', ts: 4, url: 'wss://api.example.io/live', protocols: [], resumed: true }, 'gen-2');

    const sessions = s.wsSessions('d1');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].url).toBe('wss://api.example.io/live');
    expect(sessions[0].resumed).toBeUndefined();
    expect(sessions[0].frames).toHaveLength(2); // frames not reset
  });

  it('counts an orphan frame as dropped (only) when admission refuses to synthesize', () => {
    const s = new Store({ limits: { admissionIdsPerGeneration: 0 } });
    s.appendWsFrame('w1', frame(), null, 'd1');
    expect(s.wsSessions('d1')).toHaveLength(0);
    expect(s.retentionCounters().droppedFrames).toBe(1);
  });

  it('drops an orphan frame with no deviceId (cannot synthesize) and counts it', () => {
    const s = new Store();
    s.appendWsFrame('w1', frame(), null); // no deviceId, no session
    expect(s.wsSessions()).toHaveLength(0);
    expect(s.retentionCounters().droppedFrames).toBe(1);
  });
});
