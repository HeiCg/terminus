import { describe, it, expect } from 'vitest';
import { Store } from '../src/store.js';
import type { Entry, EntryInput, EntryKey, WsKey } from '../src/types.js';

const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

const input = (id: string, deviceId: string, over: Partial<EntryInput> = {}): EntryInput => ({
  id, deviceId, source: 'atlantis', startedAt: 1, method: 'GET', url: `https://x/${id}`,
  requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
  status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: null, responseBodySize: 0,
  responseBodyOmitted: null, durationMs: 1, error: null, ...over,
});

const httpEntry = (id: string, deviceId: string, startedAt = 1): Entry => ({
  id, deviceId, source: 'xhr', startedAt, method: 'GET', url: `https://x/${id}`,
  requestHeaders: {}, requestBody: null, requestBodySize: 0, requestBodyOmitted: null,
  status: 200, statusText: 'OK', responseHeaders: {}, responseBody: null, responseBodySize: 0,
  responseBodyOmitted: null, durationMs: 1, error: null,
});

describe('body retention (R6)', () => {
  it('omits a body over the per-body cap with reason size, keeping metadata', () => {
    const s = new Store({ limits: { perBodyBytes: 8 } });
    s.addEntryInput(input('e1', 'd1', { responseBytes: bytes('0123456789'), responseBodySize: 10 }));
    const e = s.entries('d1')[0];
    expect(e.responseBody).toBeNull();
    expect(e.responseBodyOmitted).toBe('size');
    expect(e.responseBodySize).toBe(10);
    expect(s.retentionCounters().omittedBodies).toBe(1);
    expect(s.bodyStats().retainedBytes).toBe(0);
  });

  it('omits a body with reason budget when the global body budget is full', () => {
    const s = new Store({ limits: { bodyBytes: 12 } });
    s.addEntryInput(input('e1', 'd1', { responseBytes: bytes('aaaaaaaa'), responseBodySize: 8 })); // 8 <= 12
    s.addEntryInput(input('e2', 'd1', { responseBytes: bytes('bbbbbbbb'), responseBodySize: 8 })); // would be 16 > 12
    expect(s.entries('d1')[0].responseBody).toBe('aaaaaaaa');
    const e2 = s.entries('d1')[1];
    expect(e2.responseBody).toBeNull();
    expect(e2.responseBodyOmitted).toBe('budget');
    expect(s.retentionCounters().omittedBodies).toBe(1);
  });

  it('preserves binary body bytes (recoverable) though the DTO shows them omitted', () => {
    const s = new Store();
    const bin = new Uint8Array([0, 1, 2, 0xff]);
    s.addEntryInput(input('e1', 'd1', { responseBytes: bin, responseBodySize: 4, responseBodyOmitted: 'binary' }));
    const e = s.entries('d1')[0];
    expect(e.responseBody).toBeNull();
    expect(e.responseBodyOmitted).toBe('binary');
    expect(e.responseBodySize).toBe(4);
    expect(s.bodyStats().retainedBytes).toBe(4); // bytes retained and recoverable
  });

  it('dedups identical bodies across devices; clearing one keeps the other', () => {
    const s = new Store();
    s.addEntryInput(input('e1', 'd1', { responseBytes: bytes('shared-body'), responseBodySize: 11 }));
    s.addEntryInput(input('e1', 'd2', { responseBytes: bytes('shared-body'), responseBodySize: 11 }));
    expect(s.bodyStats()).toMatchObject({ blobCount: 1, references: 2 });
    s.clear('d1');
    expect(s.entries('d2')[0].responseBody).toBe('shared-body'); // d2 still recoverable
    expect(s.bodyStats().references).toBe(1);
    s.clear('d2');
    expect(s.bodyStats().retainedBytes).toBe(0);
  });
});

describe('per-message caps on every write path (IMPORTANT 2)', () => {
  it('omits an over-1-MiB body on the default legacy addEntry path', () => {
    const s = new Store(); // default spec caps: 1 MiB per body
    s.addEntry({ ...httpEntry('big', 'd1'), requestBody: 'a'.repeat(1024 * 1024 + 1), requestBodySize: 1024 * 1024 + 1 });
    const e = s.entries('d1')[0];
    expect(e.requestBody).toBeNull();
    expect(e.requestBodyOmitted).toBe('size');
    expect(e.requestBodySize).toBe(1024 * 1024 + 1);
    expect(s.bodyStats().retainedBytes).toBe(0);
  });

  it('omits an over-256-KiB WS frame on the default appendWsFrame path', () => {
    const s = new Store(); // default spec caps: 256 KiB per WS message
    s.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: 1 });
    s.appendWsFrame('w1', { ts: 1, direction: 'in', data: 'x'.repeat(256 * 1024 + 1), size: 256 * 1024 + 1, binary: false });
    const f = s.wsSessions('d1')[0].frames[0];
    expect(f.data).toBeNull();
    expect(f.size).toBe(256 * 1024 + 1);
    expect(s.retentionCounters().omittedBodies).toBe(1);
  });
});

describe('WS admission integration (IMPORTANT 3/4/8)', () => {
  it('counts a frame for a session that does not exist as dropped', () => {
    const s = new Store();
    s.appendWsFrame('ghost', { ts: 1, direction: 'in', data: 'x', size: 1, binary: false }, null, 'd1');
    expect(s.retentionCounters().droppedFrames).toBe(1);
  });

  it('stamps a session opened from an orphan frame as partial', () => {
    const s = new Store();
    s.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'atlantis', url: 'wss://x', openedAt: 1, via: 'frame' });
    expect(s.wsSessions('d1')[0].partial).toBe(true);
    // A clean handshake open is not partial.
    s.addWsSession({ wsId: 'w2', deviceId: 'd1', source: 'atlantis', url: 'wss://y', openedAt: 2, via: 'open' });
    expect(s.wsSessions('d1').find((w) => w.wsId === 'w2')!.partial).toBeUndefined();
  });

  it('routes frames by composite (deviceId, wsId): two devices sharing a wsId never cross', () => {
    const s = new Store();
    s.addWsSession({ wsId: 'w', deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: 1 });
    s.addWsSession({ wsId: 'w', deviceId: 'd2', source: 'xhr', url: 'wss://y', openedAt: 1 });
    s.appendWsFrame('w', { ts: 1, direction: 'in', data: 'to-d1', size: 5, binary: false }, null, 'd1');
    expect(s.wsSessions('d1')[0].frames).toHaveLength(1);
    expect(s.wsSessions('d2')[0].frames).toHaveLength(0);
    expect(s.wsSessions('d1')[0].frames[0].data).toBe('to-d1');
  });
});

describe('session admission overload on the WSS path (round 2)', () => {
  it('refuses new sessions when the generation registry is full and counts them', () => {
    const s = new Store({ limits: { admissionIdsPerGeneration: 2 } });
    expect(s.addWsSession({ wsId: 'w0', deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: 0, generation: 'g1' })).toBe('new');
    expect(s.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: 1, generation: 'g1' })).toBe('new');
    expect(s.addWsSession({ wsId: 'w2', deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: 2, generation: 'g1' })).toBe('overload');
    expect(s.wsSessions('d1')).toHaveLength(2);                 // the refused one was not stored
    expect(s.retentionCounters().refusedSessions).toBe(1);     // …and it is counted (IMPORTANT 4)
  });

  it('emits a retention event carrying refusedSessions (round 3)', () => {
    const s = new Store({ limits: { admissionIdsPerGeneration: 1 } });
    const events: Array<{ refusedSessions: number }> = [];
    s.on('retention', (e: { refusedSessions: number }) => events.push(e));
    s.addWsSession({ wsId: 'w0', deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: 0, generation: 'g1' }); // clean, no event
    s.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: 1, generation: 'g1' }); // refused
    expect(events).toHaveLength(1);
    expect(events[0].refusedSessions).toBe(1);
  });

  it('applyDeviceMessage propagates the ws_open overload so the transport can close', () => {
    const s = new Store({ limits: { admissionIdsPerGeneration: 1 } });
    s.applyDeviceMessage('d1', { type: 'ws_open', wsId: 'w0', ts: 0, url: 'wss://x', protocols: [] }, 'conn-1');
    const r = s.applyDeviceMessage('d1', { type: 'ws_open', wsId: 'w1', ts: 1, url: 'wss://x', protocols: [] }, 'conn-1');
    expect(r).toBe('overload');
  });

  it('clear(device) reclaims admission capacity (no permanent overload)', () => {
    const s = new Store({ limits: { admissionIdsPerGeneration: 1 } });
    s.addWsSession({ wsId: 'w0', deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: 0, generation: 'g1' });
    expect(s.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: 1, generation: 'g1' })).toBe('overload');
    s.clear('d1'); // UI clear resets this device's admission on the same connection
    expect(s.addWsSession({ wsId: 'w2', deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: 2, generation: 'g1' })).toBe('new');
    expect(s.wsSessions('d1').map((w) => w.wsId)).toEqual(['w2']);
  });
});

describe('metadata budget includes the admission registry (IMPORTANT 5)', () => {
  it('counts admitted session ids toward retainedMetadataBytes', () => {
    const s = new Store();
    const before = s.retentionCounters().retainedMetadataBytes;
    for (let i = 0; i < 50; i++) s.addWsSession({ wsId: `w${i}`, deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: i });
    // The registry contributes on top of the session records themselves.
    expect(s.retentionCounters().retainedMetadataBytes).toBeGreaterThan(before);
  });
});

describe('count retention (R6)', () => {
  it('evicts oldest HTTP entries per device and emits removals', () => {
    const s = new Store({ limits: { httpPerDevice: 3 } });
    const removed: EntryKey[] = [];
    s.on('entries_removed', (e: { keys: EntryKey[] }) => removed.push(...e.keys));
    for (let i = 0; i < 5; i++) s.addEntry(httpEntry(`e${i}`, 'd1', i));
    expect(s.entries('d1').map((e) => e.id)).toEqual(['e2', 'e3', 'e4']);
    expect(removed.map((k) => k.id)).toEqual(['e0', 'e1']);
    expect(s.retentionCounters().droppedEntries).toBe(2);
    expect(s.atMax()).toBe(true);
  });

  it('evicts oldest HTTP entries globally across devices', () => {
    const s = new Store({ limits: { httpGlobal: 3 } });
    s.addEntry(httpEntry('a', 'd1', 1));
    s.addEntry(httpEntry('b', 'd2', 2));
    s.addEntry(httpEntry('c', 'd1', 3));
    s.addEntry(httpEntry('d', 'd2', 4)); // pushes global to 4 -> oldest 'a' evicted
    const all = s.entries().map((e) => e.id);
    expect(all).not.toContain('a');
    expect(all).toHaveLength(3);
  });

  it('evicts oldest WS sessions per device and emits sessions_removed', () => {
    const s = new Store({ limits: { wsSessionsPerDevice: 2 } });
    const removed: WsKey[] = [];
    s.on('sessions_removed', (e: { keys: WsKey[] }) => removed.push(...e.keys));
    for (let i = 0; i < 4; i++) s.addWsSession({ wsId: `w${i}`, deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: i });
    expect(s.wsSessions('d1').map((w) => w.wsId)).toEqual(['w2', 'w3']);
    expect(removed.map((k) => k.wsId)).toEqual(['w0', 'w1']);
  });

  it('evicts oldest WS messages per session, counting dropped frames', () => {
    const s = new Store({ limits: { wsMessagesPerSession: 2 } });
    s.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: 1 });
    for (let i = 0; i < 5; i++) s.appendWsFrame('w1', { ts: i, direction: 'in', data: `f${i}`, size: 2, binary: false });
    const frames = s.wsSessions('d1')[0].frames;
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.data)).toEqual(['f3', 'f4']);
    expect(s.retentionCounters().droppedFrames).toBe(3);
  });

  it('bounds WS messages globally across sessions', () => {
    const s = new Store({ limits: { wsMessagesGlobal: 4, wsMessagesPerSession: 100 } });
    s.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://x', openedAt: 1 });
    s.addWsSession({ wsId: 'w2', deviceId: 'd1', source: 'xhr', url: 'wss://y', openedAt: 2 });
    for (let i = 0; i < 4; i++) s.appendWsFrame('w1', { ts: i, direction: 'in', data: `a${i}`, size: 2, binary: false });
    for (let i = 0; i < 4; i++) s.appendWsFrame('w2', { ts: i, direction: 'in', data: `b${i}`, size: 2, binary: false });
    const total = s.wsSessions().reduce((n, w) => n + w.frames.length, 0);
    expect(total).toBe(4);
    expect(s.retentionCounters().droppedFrames).toBe(4);
  });
});

describe('metadata retention (R6)', () => {
  it('rejects a single record above the record cap and counts it', () => {
    const s = new Store({ limits: { maxRecordBytes: 200 } });
    s.addEntry({ ...httpEntry('big', 'd1'), url: 'https://x/' + 'u'.repeat(500) });
    expect(s.entries('d1')).toHaveLength(0);
    expect(s.retentionCounters().rejectedRecords).toBe(1);
  });

  it('evicts old metadata until under the metadata budget', () => {
    const s = new Store({ limits: { metadataBytes: 600 } });
    for (let i = 0; i < 20; i++) s.addEntry(httpEntry(`e${i}`, 'd1', i));
    expect(s.retentionCounters().retainedMetadataBytes).toBeLessThanOrEqual(600);
    expect(s.entries('d1').length).toBeLessThan(20); // oldest evicted
  });
});

describe('retention events', () => {
  it('emits retention only when something is dropped, not on a clean add', () => {
    const s = new Store({ limits: { httpPerDevice: 2 } });
    const events: unknown[] = [];
    s.on('retention', (e) => events.push(e));
    s.addEntry(httpEntry('a', 'd1', 1)); // clean
    s.addEntry(httpEntry('b', 'd1', 2)); // clean
    expect(events).toHaveLength(0);
    s.addEntry(httpEntry('c', 'd1', 3)); // evicts 'a'
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'retention', droppedEntries: 1 });
  });
});

describe('retention stress', () => {
  it('keeps every axis under its limit and zeroes references after clear', () => {
    const s = new Store();
    // 20001 HTTP entries across two devices; per-device 5000, global 20000.
    for (let i = 0; i < 20001; i++) s.addEntryInput(input(`h${i}`, i % 2 === 0 ? 'd1' : 'd2', { responseBytes: bytes(`b${i % 7}`), responseBodySize: 2 }));
    expect(s.entries('d1').length).toBeLessThanOrEqual(5000);
    expect(s.entries('d2').length).toBeLessThanOrEqual(5000);
    expect(s.entries().length).toBeLessThanOrEqual(20000);

    // 501 WS sessions on one device; per-device cap 100, global 500.
    for (let i = 0; i < 501; i++) s.addWsSession({ wsId: `s${i}`, deviceId: 'd3', source: 'xhr', url: 'wss://x', openedAt: i });
    expect(s.wsSessions('d3').length).toBeLessThanOrEqual(100);
    expect(s.wsSessions().length).toBeLessThanOrEqual(500);

    // 20001 messages on a single session; per-session cap 2000, global 20000.
    s.addWsSession({ wsId: 'big', deviceId: 'd4', source: 'xhr', url: 'wss://x', openedAt: 1 });
    for (let i = 0; i < 20001; i++) s.appendWsFrame('big', { ts: i, direction: 'in', data: `m${i % 5}`, size: 2, binary: false });
    const bigFrames = s.wsSessions('d4').find((w) => w.wsId === 'big')!.frames.length;
    expect(bigFrames).toBeLessThanOrEqual(2000);

    const c = s.retentionCounters();
    expect(c.retainedBodyBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(c.retainedMetadataBytes).toBeLessThanOrEqual(32 * 1024 * 1024);

    s.clear();
    expect(s.bodyStats().retainedBytes).toBe(0);
    expect(s.bodyStats().references).toBe(0);
    expect(s.entries().length).toBe(0);
    expect(s.wsSessions().length).toBe(0);
  });
});
