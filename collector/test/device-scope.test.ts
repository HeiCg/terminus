import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Store } from '../src/store.js';
import type { Device, EntryInput } from '../src/types.js';
import type { CollectorIdentity } from '../src/security/types.js';
import { apply, completedInner, envelope, createTestIdentity, until, withAtlantisCollector } from './fixtures/atlantisWire.js';

// P2: device-scope filters `device=` (alias-resolving), `externalId=` and
// `bundleId=` on GET /api/entries (cursor, afterSeq, last) and GET /api/devices,
// and the store's device-set reads behind them.

let identity: CollectorIdentity;
let dispose: () => Promise<void>;
beforeAll(async () => { ({ identity, dispose } = await createTestIdentity()); });
afterAll(async () => { await dispose(); });

const ids = (b: { items: { deviceId: string; id: string }[] }) => b.items.map((e) => `${e.deviceId}:${e.id}`);

describe('two Atlantis clients of the same app (P2)', () => {
  const A = 'com.acme.app-emulator-5554';
  const B = 'com.acme.app-emulator-5556';

  it('are two devices with separate traffic; externalId= isolates each in afterSeq, last and cursor modes', () => withAtlantisCollector(identity, async ({ h, client, get }) => {
    const a = await client(A, { device: { name: 'Pixel', model: 'sdk_gphone64 (Android 14)', externalId: 'emulator-5554' } });
    const b = await client(B, { device: { name: 'Pixel', model: 'sdk_gphone64 (Android 14)', externalId: 'emulator-5556' } });
    a.write(envelope(A, 'traffic', completedInner('a1'))); b.write(envelope(B, 'traffic', completedInner('b1')));
    a.write(envelope(A, 'traffic', completedInner('a2'))); b.write(envelope(B, 'traffic', completedInner('b2')));
    await until(() => h.store.entries(A).length === 2 && h.store.entries(B).length === 2);

    const devices = (await (await get('/api/devices')).json()).items as Device[];
    expect(devices.map((d) => d.deviceId)).toEqual([A, B]);
    expect(devices[0]).toMatchObject({ bundleId: 'com.acme.app', appName: 'Acme', deviceName: 'Pixel', model: 'sdk_gphone64 (Android 14)', externalId: 'emulator-5554', platform: 'android' });
    expect(devices[1].externalId).toBe('emulator-5556');
    expect(devices[0].ambiguous).toBeUndefined();

    const after = await (await get('/api/entries?afterSeq=0&externalId=emulator-5554')).json();
    expect(ids(after)).toEqual([`${A}:a1`, `${A}:a2`]);
    expect(after.devices).toEqual([A]);
    const last = await (await get('/api/entries?last=10&externalId=emulator-5556')).json();
    expect(ids(last)).toEqual([`${B}:b1`, `${B}:b2`]);
    expect(last.devices).toEqual([B]);
    const cursor = await (await get('/api/entries?externalId=emulator-5554')).json();
    expect(ids(cursor).sort()).toEqual([`${A}:a1`, `${A}:a2`]);
    expect(Object.keys(cursor).sort()).toEqual(['items', 'nextCursor']); // cursor shape unchanged
    const devA = (await (await get('/api/devices?externalId=emulator-5554')).json()).items as Device[];
    expect(devA.map((d) => d.deviceId)).toEqual([A]);
    a.destroy(); b.destroy();
  }));

  it('bundleId= returns both devices and lists them in `devices`; no match is empty with devices: []', () => withAtlantisCollector(identity, async ({ h, client, get }) => {
    const a = await client(A, { device: { name: 'Pixel', model: 'm', externalId: 'emulator-5554' } });
    const b = await client(B, { device: { name: 'Pixel', model: 'm', externalId: 'emulator-5556' } });
    a.write(envelope(A, 'traffic', completedInner('a1'))); b.write(envelope(B, 'traffic', completedInner('b1')));
    await until(() => h.store.entries(A).length === 1 && h.store.entries(B).length === 1);

    const both = await (await get('/api/entries?afterSeq=0&bundleId=com.acme.app')).json();
    expect(both.devices).toEqual([A, B]);
    expect(ids(both).sort()).toEqual([`${A}:a1`, `${B}:b1`]);
    const lastBoth = await (await get('/api/entries?last=5&bundleId=com.acme.app')).json();
    expect(ids(lastBoth).sort()).toEqual([`${A}:a1`, `${B}:b1`]);
    // Cursor mode supports a multi-device set too (global index, member filter).
    const cursorBoth = await (await get('/api/entries?bundleId=com.acme.app')).json();
    expect(cursorBoth.items).toHaveLength(2);
    expect(cursorBoth.devices).toBeUndefined();
    // Filters intersect: bundle AND externalId narrows to one device.
    const one = await (await get('/api/entries?afterSeq=0&bundleId=com.acme.app&externalId=emulator-5556')).json();
    expect(one.devices).toEqual([B]);
    expect(ids(one)).toEqual([`${B}:b1`]);
    const none = await get('/api/entries?afterSeq=0&bundleId=com.other');
    expect(none.status).toBe(200);
    expect(await none.json()).toMatchObject({ items: [], devices: [], gap: false, hasMore: false });
    expect(await (await get('/api/entries?last=3&externalId=nope')).json()).toMatchObject({ items: [], devices: [] });
    expect((await (await get('/api/entries?bundleId=com.other')).json()).items).toEqual([]);
    expect((await (await get('/api/devices?bundleId=com.other')).json()).items).toEqual([]);
    a.destroy(); b.destroy();
  }));
});

describe('device= resolves an alias (P2)', () => {
  it('returns the canonical device entries in afterSeq, last and cursor modes', () => withAtlantisCollector(identity, async ({ h, get }) => {
    h.store.applyDeviceMessage('app-1', { type: 'hello', deviceId: 'app-1', platform: 'android', appVersion: '1', buildProfile: 'unknown', dropped: 0, ts: 100, atlantisDeviceKey: 'sdk-key' });
    apply(h.store, 'sdk-key', 'traffic', completedInner('t1'));
    for (const q of ['afterSeq=0&', 'last=5&', '']) {
      const b = await (await get(`/api/entries?${q}device=sdk-key`)).json();
      expect(ids(b)).toEqual(['app-1:t1']);
      expect(b.devices).toBeUndefined(); // only externalId/bundleId echo the set
    }
    const devs = (await (await get('/api/devices?device=sdk-key')).json()).items as Device[];
    expect(devs.map((d) => d.deviceId)).toEqual(['app-1']);
  }));
});

describe('device sets in the store (P2)', () => {
  const input = (id: string, deviceId: string): EntryInput => ({
    id, deviceId, source: 'atlantis', startedAt: 1, method: 'GET', url: `https://x/${id}`,
    requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: null, responseBodySize: 0,
    responseBodyOmitted: null, durationMs: 1, error: null,
  });

  it('deviceIds walks several devices in seq order; empty matches nothing; gap is true if any member has one', () => {
    const s = new Store({ limits: { httpPerDevice: 2 } });
    s.addEntryInput(input('a1', 'A')); s.addEntryInput(input('b1', 'B')); s.addEntryInput(input('c1', 'C'));
    s.addEntryInput(input('a2', 'A')); s.addEntryInput(input('b2', 'B'));
    expect(s.entriesAfterSeq(0, { deviceIds: ['A', 'B'] }).items.map((e) => e.id)).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(s.lastEntries(3, { deviceIds: ['B', 'A'] }).items.map((e) => e.id)).toEqual(['b1', 'a2', 'b2']);
    expect(s.entriesAfterSeq(0, { deviceIds: [] })).toMatchObject({ items: [], gap: false });
    expect(s.entrySummaryPage(null, []).items).toEqual([]);
    expect(s.entriesAfterSeq(0, { deviceIds: ['A', 'C'] }).gap).toBe(false);
    s.addEntryInput(input('a3', 'A')); // evicts a1 (per-device cap 2)
    expect(s.entriesAfterSeq(0, { deviceIds: ['B', 'C'] }).gap).toBe(false);
    expect(s.entriesAfterSeq(0, { deviceIds: ['A', 'C'] }).gap).toBe(true);
  });
});
