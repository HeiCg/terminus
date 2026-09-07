import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { decodeAtlantis } from '../src/atlantis/decode.js';
const envelope = (messageType: string, inner: unknown, gz = true) => {
  const json = JSON.stringify({ id: 'com.example.app-iPhone15,2', messageType, content: Buffer.from(JSON.stringify(inner)).toString('base64'), buildVersion: '1.36.0' });
  return gz ? gzipSync(Buffer.from(json)) : Buffer.from(json);
};
const traffic = { id: 'T1', startAt: 1700000000.5, endAt: 1700000000.75, packageType: 'http',
  request: { url: 'https://api.example.io/x?access_token=tok', method: 'GET', headers: [{ key: 'access-token', value: 'tok' }, { key: 'Accept', value: 'json' }], body: null },
  response: { statusCode: 200, headers: [{ key: 'Content-Type', value: 'application/json' }] },
  responseBodyData: Buffer.from('{"ok":1}').toString('base64'), error: null };
describe('decodeAtlantis', () => {
  it('decodes gzipped traffic into a redacted EntryInput preserving bytes', () => {
    const ev = decodeAtlantis(envelope('traffic', traffic));
    expect(ev?.kind).toBe('traffic'); if (ev?.kind !== 'traffic') return;
    expect(ev.deviceKey).toBe('com.example.app-iPhone15,2');
    expect(ev.entry).toMatchObject({ id: 'T1', source: 'atlantis', method: 'GET', url: 'https://api.example.io/x?access_token=***', startedAt: 1700000000500, durationMs: 250, status: 200,
      requestHeaders: { 'access-token': '***', Accept: 'json' }, responseHeaders: { 'Content-Type': 'application/json' }, responseBodySize: 8 });
    // Bytes are preserved (recoverable), not a materialized text field.
    expect(Buffer.from(ev.entry.responseBytes!).toString('utf8')).toBe('{"ok":1}');
    expect(ev.entry.responseBodyOmitted).toBeNull();
  });
  it('accepts uncompressed payload (fallback)', () => { expect(decodeAtlantis(envelope('connection', { device: { name: 'n', model: 'm' }, project: { name: 'p', bundleIdentifier: 'b' }, icon: '' }, false))?.kind).toBe('connection'); });
  it('maps error traffic', () => {
    const ev = decodeAtlantis(envelope('traffic', { ...traffic, response: null, responseBodyData: null, error: { code: -1001, message: 'timed out' } }));
    if (ev?.kind !== 'traffic') throw new Error('kind'); expect(ev.entry.status).toBeNull(); expect(ev.entry.error).toBe('-1001 timed out');
  });
  it('returns null for unknown messageType or garbage', () => {
    expect(decodeAtlantis(envelope('nope', {}))).toBeNull(); expect(decodeAtlantis(Buffer.from('zzz'))).toBeNull();
  });
  it('marks <Skip Large Body>', () => {
    const ev = decodeAtlantis(envelope('traffic', { ...traffic, responseBodyData: Buffer.from('<Skip Large Body>').toString('base64') }));
    if (ev?.kind !== 'traffic') throw new Error('kind'); expect(ev.entry.responseBytes).toBeNull();
    expect(ev.entry.responseBodyOmitted).toBe('size');
  });
  it('marks the Android <Body too large> sentinel too (C1)', () => {
    const ev = decodeAtlantis(envelope('traffic', { ...traffic, responseBodyData: Buffer.from('<Body too large>').toString('base64') }));
    if (ev?.kind !== 'traffic') throw new Error('kind');
    expect(ev.entry.responseBytes).toBeNull();
    expect(ev.entry.responseBodyOmitted).toBe('size');
  });
  it('exposes appVersion and passcode from the ConnectionPackage (C3/C4)', () => {
    const ev = decodeAtlantis(envelope('connection', { device: { name: 'n', model: 'Pixel 7 (Android 14)' }, project: { name: 'p', bundleIdentifier: 'b' }, appVersion: '1.36.0', passcode: 'abcd' }));
    if (ev?.kind !== 'connection') throw new Error('kind');
    expect(ev.appVersion).toBe('1.36.0');
    expect(ev.passcode).toBe('abcd');
    expect(ev.device.model).toBe('Pixel 7 (Android 14)');
  });
  it('defaults appVersion/passcode to null when absent (C3/C4 compat)', () => {
    const ev = decodeAtlantis(envelope('connection', { device: { name: 'n', model: 'iPhone15,2' }, project: { name: 'p', bundleIdentifier: 'b' } }));
    if (ev?.kind !== 'connection') throw new Error('kind');
    expect(ev.appVersion).toBeNull();
    expect(ev.passcode).toBeNull();
  });
  it('preserves binary body bytes and sizes it in bytes, not string length (N1)', () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]); // PNG-ish with NUL
    const ev = decodeAtlantis(envelope('traffic', { ...traffic, responseBodyData: bin.toString('base64') }));
    if (ev?.kind !== 'traffic') throw new Error('kind');
    // The bytes are preserved and recoverable; the DTO marks them binary.
    expect(ev.entry.responseBytes).not.toBeNull();
    expect(Buffer.from(ev.entry.responseBytes!)).toEqual(bin);
    expect(ev.entry.responseBodyOmitted).toBe('binary');
    expect(ev.entry.responseBodySize).toBe(7);
  });
  it('rejects a body over the per-body cap before conversion (O05)', () => {
    const big = Buffer.alloc(2048, 0x61); // 2 KiB of 'a'
    const ev = decodeAtlantis(envelope('traffic', { ...traffic, responseBodyData: big.toString('base64') }), { maxEnvelope: 8 * 1024 * 1024, maxInnerJson: 4 * 1024 * 1024, maxBody: 1024 });
    if (ev?.kind !== 'traffic') throw new Error('kind');
    expect(ev.entry.responseBytes).toBeNull();
    expect(ev.entry.responseBodyOmitted).toBe('size');
    expect(ev.entry.responseBodySize).toBe(2048);
  });
  it('keeps repeated headers instead of collapsing (N2)', () => {
    const ev = decodeAtlantis(envelope('traffic', { ...traffic,
      response: { statusCode: 200, headers: [{ key: 'X-Dup', value: 'a=1' }, { key: 'X-Dup', value: 'b=2' }] } }));
    if (ev?.kind !== 'traffic') throw new Error('kind');
    expect(ev.entry.responseHeaders['X-Dup']).toBe('a=1\nb=2');
  });
  it('redacts tokens inside a websocket stringValue (N9)', () => {
    const inner = { id: 'W1', startAt: 1, request: { url: 'wss://x/cable', method: 'GET' },
      websocketMessagePackage: { id: 'm1', createdAt: 1, messageType: 'send',
        stringValue: '{"command":"subscribe","identifier":"{\\"access_token\\":\\"sekret\\"}"}', dataValue: null } };
    const ev = decodeAtlantis(envelope('websocket', inner));
    if (ev?.kind !== 'ws') throw new Error('kind');
    expect(ev.msg.text).not.toContain('sekret');
    expect(ev.msg.text).toContain('***');
    expect(ev.msg.binary).toBe(false);
  });
  it('preserves binary websocket frame bytes decoded once (N1/O05)', () => {
    const bin = Buffer.from([0, 1, 2, 0xff, 0xfe]);
    const inner = { id: 'W2', startAt: 1, request: { url: 'wss://x/ws', method: 'GET' },
      websocketMessagePackage: { id: 'm2', createdAt: 1, messageType: 'receive', stringValue: null, dataValue: bin.toString('base64') } };
    const ev = decodeAtlantis(envelope('websocket', inner));
    if (ev?.kind !== 'ws') throw new Error('kind');
    expect(ev.msg.binary).toBe(true);
    expect(ev.msg.text).toBeNull();
    expect(Buffer.from(ev.msg.bytes!)).toEqual(bin);
    expect(ev.msg.size).toBe(5);
  });
});
