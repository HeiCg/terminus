import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Store } from '../src/store.js';
import { isDeviceMessage, type Device } from '../src/types.js';
import type { CollectorIdentity } from '../src/security/types.js';
import { createCollectorHarness } from './fixtures/harness.js';
import { apply, connectionInner, completedInner, startInner, envelope, createTestIdentity, until, withAtlantisCollector } from './fixtures/atlantisWire.js';

// P2: device and app identity on the Device record (ConnectionPackage and hello),
// the sticky `ambiguous` / `startEvents` flags, and the two Atlantis upsert guards
// (a stale start packet, a start packet followed by SSE traffic).

let identity: CollectorIdentity;
let dispose: () => Promise<void>;
beforeAll(async () => { ({ identity, dispose } = await createTestIdentity()); });
afterAll(async () => { await dispose(); });

describe('ambiguous envelope id (P2)', () => {
  it('two simultaneous connections announcing the same id: one device, ambiguous', () => withAtlantisCollector(identity, async ({ h, client, get }) => {
    const a = await client('com.acme.app');
    const b = await client('com.acme.app');
    await until(() => h.store.devices()[0]?.ambiguous === true);
    const devices = (await (await get('/api/devices')).json()).items as Device[];
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ deviceId: 'com.acme.app', ambiguous: true });
    // Traffic is not split: both connections land on the one device.
    a.write(envelope('com.acme.app', 'traffic', completedInner('x1'))); b.write(envelope('com.acme.app', 'traffic', completedInner('x2')));
    await until(() => h.store.entries('com.acme.app').length === 2);
    // Sticky after one side goes away; reset only by a clear.
    b.destroy();
    await until(() => h.store.devices()[0].channels?.atlantis != null);
    expect(h.store.devices()[0].ambiguous).toBe(true);
    h.store.clear();
    expect(h.store.devices()[0].ambiguous).toBeUndefined();
    a.destroy();
  }));

  it('a sequential reconnect of one client does not mark it', () => withAtlantisCollector(identity, async ({ h, client, shared }) => {
    const first = await client('solo');
    first.destroy();
    await until(() => shared.slots.count() === 0); // the server released the old connection
    const second = await client('solo');
    expect(h.store.devices()).toHaveLength(1);
    expect(h.store.devices()[0].ambiguous).toBeUndefined();
    second.destroy();
  }));
});

describe('identity merge (P2)', () => {
  const hello = (over: Record<string, unknown> = {}) => ({ type: 'hello' as const, deviceId: 'app-1', platform: 'ios' as const, appVersion: '1.0', buildProfile: 'dev', dropped: 0, ts: 100, ...over });

  it('a later ConnectionPackage or hello without the fields does not erase them', () => withAtlantisCollector(identity, async ({ h, get }) => {
    apply(h.store, 'sdk-1', 'connection', connectionInner({ device: { name: 'iPhone 15', model: 'iPhone15,4', externalId: 'SIM-UDID-1' }, project: { name: 'Acme', bundleIdentifier: 'com.acme.app' } }));
    // Reconnect with a package that lacks every identity field (and a blank one).
    apply(h.store, 'sdk-1', 'connection', { device: { name: '', model: 7 } });
    h.store.applyDeviceMessage('sdk-1', hello({ deviceId: 'sdk-1' }));
    const d = (await (await get('/api/devices')).json()).items[0] as Device;
    expect(d).toMatchObject({ deviceId: 'sdk-1', bundleId: 'com.acme.app', appName: 'Acme', deviceName: 'iPhone 15', model: 'iPhone15,4', externalId: 'SIM-UDID-1' });
    // A new real value does replace the old one.
    apply(h.store, 'sdk-1', 'connection', connectionInner({ device: { name: 'Renamed', model: 'iPhone15,4', externalId: 'SIM-UDID-1' } }));
    expect(h.store.devices()[0].deviceName).toBe('Renamed');
  }));

  it('hello carries the optional identity fields; invalid ones are ignored, the hello still applies', () => {
    const s = new Store();
    const good = hello({ bundleId: 'com.acme.app', deviceName: 'QA iPhone', model: 'iPhone16,1', externalId: 'UDID-9' });
    expect(isDeviceMessage(good)).toBe(true);
    s.applyDeviceMessage('app-1', good);
    expect(s.devices()[0]).toMatchObject({ bundleId: 'com.acme.app', deviceName: 'QA iPhone', model: 'iPhone16,1', externalId: 'UDID-9' });

    const s2 = new Store();
    const bad = hello({ bundleId: 42, deviceName: { x: 1 }, model: 'x'.repeat(300), externalId: '   ', appVersion: '2.0' });
    expect(isDeviceMessage(bad)).toBe(true); // never a reason to refuse the hello
    s2.applyDeviceMessage('app-1', bad as Parameters<Store['applyDeviceMessage']>[1]);
    const d = s2.devices()[0];
    expect(d.appVersion).toBe('2.0');
    for (const f of ['bundleId', 'deviceName', 'model', 'externalId'] as const) expect(d[f]).toBeUndefined();
    // And a bad later hello keeps the earlier good values.
    s.applyDeviceMessage('app-1', bad as Parameters<Store['applyDeviceMessage']>[1]);
    expect(s.devices()[0]).toMatchObject({ bundleId: 'com.acme.app', deviceName: 'QA iPhone', model: 'iPhone16,1', externalId: 'UDID-9' });
  });

  it('the `device` delta the /ui fanout carries includes the identity fields', () => {
    const s = new Store();
    const seen: Device[] = [];
    s.on('device', (d: Device) => seen.push(d));
    s.applyDeviceMessage('app-1', hello({ bundleId: 'com.acme.app', externalId: 'UDID-9' }));
    expect(seen.at(-1)).toMatchObject({ bundleId: 'com.acme.app', externalId: 'UDID-9' });
  });
});

describe('request-start packets (P2)', () => {
  const connect = (s: Store) => apply(s, 'dev', 'connection', connectionInner({}));

  it('start then completion: one entry, firstSeq from the start, startEvents on the device', () => {
    const s = new Store();
    connect(s);
    expect(s.devices()[0].startEvents).toBeUndefined();
    apply(s, 'dev', 'traffic', startInner('r1'));
    const start = s.entriesAfterSeq(0).items;
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ id: 'r1', status: null, error: null });
    expect(s.devices()[0].startEvents).toBe(true);
    apply(s, 'dev', 'traffic', completedInner('r1'));
    const done = s.entriesAfterSeq(0).items;
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id: 'r1', status: 200, firstSeq: start[0].seq });
    expect(done[0].seq).toBeGreaterThan(start[0].seq!);
  });

  it('a start packet with no completion is returned with status null', () => withAtlantisCollector(identity, async ({ h, get }) => {
    connect(h.store);
    apply(h.store, 'dev', 'traffic', startInner('pending'));
    const b = await (await get('/api/entries?afterSeq=0')).json();
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ id: 'pending', status: null, error: null, durationMs: null });
    const d = (await (await get('/api/devices')).json()).items[0] as Device;
    expect(d.startEvents).toBe(true);
  }));

  it('an XHR `request` message marks startEvents', () => {
    const s = new Store();
    s.applyDeviceMessage('app-1', { type: 'hello', deviceId: 'app-1', platform: 'ios', appVersion: '1', buildProfile: 'dev', dropped: 0, ts: 1 });
    expect(s.devices()[0].startEvents).toBeUndefined();
    s.applyDeviceMessage('app-1', { type: 'request', id: 'x1', ts: 2, method: 'GET', url: 'https://x/', headers: {}, body: null, bodySize: 0, source: 'xhr' });
    expect(s.devices()[0].startEvents).toBe(true);
  });

  it('Guard A: a start packet after the completed packet changes nothing (seq, status, body refs)', () => {
    const s = new Store();
    connect(s);
    apply(s, 'dev', 'traffic', completedInner('r1'));
    const before = s.entryDetail('dev', 'r1')!;
    const seqBefore = s.seqState().lastSeq;
    const deltas: unknown[] = [];
    s.on('entry', (e) => deltas.push(e));
    apply(s, 'dev', 'traffic', startInner('r1')); // replayed out of order by the offline queue
    expect(deltas).toEqual([]);
    expect(s.seqState().lastSeq).toBe(seqBefore);
    expect(s.entryDetail('dev', 'r1')).toEqual(before);
    expect(before.status).toBe(200);
    expect(before.responseBody.state).toBe('captured');
    // The device still learned that it sends start packets.
    expect(s.devices()[0].startEvents).toBe(true);
  });

  it('Guard A also holds for an entry completed with an error', () => {
    const s = new Store();
    connect(s);
    apply(s, 'dev', 'traffic', completedInner('r2', { response: null, responseBodyData: null, error: { code: -1001, message: 'timed out' } }));
    const seqBefore = s.seqState().lastSeq;
    apply(s, 'dev', 'traffic', startInner('r2'));
    expect(s.seqState().lastSeq).toBe(seqBefore);
    expect(s.entryDetail('dev', 'r2')!.error).toBe('-1001 timed out');
  });

  // Guard B. The iOS fork turns an SSE exchange into a `websocket`-typed traffic
  // package (sent once the event-stream response arrives) plus `websocket` message
  // frames under the SAME id, and never sends an `http` completion for it. With
  // emitRequestStart the `http` start packet comes first. Result: the start entry
  // is upserted in place by the SSE handshake package (one entry, firstSeq from the
  // start, status 200), the stream is one session keyed by that id, and a start
  // packet replayed after it is dropped by Guard A.
  it('Guard B: start packet then SSE traffic under the same id stays one entry plus one stream', () => {
    const s = new Store();
    connect(s);
    apply(s, 'dev', 'traffic', { ...startInner('sse1'), request: { url: 'https://api.example/stream', method: 'GET', headers: [{ key: 'Accept', value: 'text/event-stream' }] } });
    const startSeq = s.seqState().lastSeq;
    const sseHandshake = {
      id: 'sse1', startAt: 10, endAt: null, packageType: 'websocket',
      request: { url: 'https://api.example/stream', method: 'GET', headers: [{ key: 'Accept', value: 'text/event-stream' }] },
      response: { statusCode: 200, headers: [{ key: 'Content-Type', value: 'text/event-stream; charset=utf-8' }] }, responseBodyData: '', error: null,
    };
    apply(s, 'dev', 'traffic', sseHandshake);
    for (const [i, text] of ['data: one', 'data: two'].entries()) {
      apply(s, 'dev', 'websocket', { ...sseHandshake, websocketMessagePackage: { id: 'sse1', createdAt: 11 + i, messageType: 'receive', stringValue: text } });
    }
    apply(s, 'dev', 'traffic', startInner('sse1')); // stale replay of the start

    const entries = s.entriesAfterSeq(0).items;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'sse1', status: 200, firstSeq: startSeq, error: null });
    expect(s.entryDetail('dev', 'sse1')!.responseHeaders['Content-Type']).toContain('text/event-stream');
    const sessions = s.wsSessions('dev');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ wsId: 'sse1', url: 'https://api.example/stream' });
    expect(sessions[0].frames.map((f) => f.data)).toEqual(['data: one', 'data: two']);
  });
});

describe('capabilities (P2)', () => {
  it('advertises device-identity', async () => {
    const h = await createCollectorHarness();
    try {
      expect((await (await fetch(h.url + '/health')).json()).capabilities).toContain('device-identity');
    } finally { await h.close(); }
  });
});
