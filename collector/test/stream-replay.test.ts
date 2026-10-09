import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { generateCACertificate } from 'mockttp';
import { Store } from '../src/store.js';
import { performStreamReplay, looksLikeTlsHandshake, isMetadataRange, type StreamReplayResult } from '../src/streamReplay.js';
import type { StreamInfo } from '../src/types.js';
import { createCollectorHarness } from './fixtures/harness.js';

// U7: POST /api/replay/stream. Every destination is a local echo server: a plain
// TCP one and a TLS one with its own self-signed certificate (trusted through the
// test-only `tlsOptions.ca`; the route itself always verifies).

let own: { key: string; cert: string };
type Srv = { port: number; received: () => Buffer; close: () => void };
let echo: Srv;
let tlsEcho: Srv;
let closer: Srv;

function server(onSock: (s: net.Socket, got: Buffer[]) => void, opts?: { key: string; cert: string }): Promise<Srv> {
  const got: Buffer[] = [];
  const handler = (s: net.Socket) => { s.on('error', () => {}); onSock(s, got); };
  const srv = opts ? tls.createServer(opts, handler) : net.createServer(handler);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    port: (srv.address() as AddressInfo).port, received: () => Buffer.concat(got), close: () => srv.close(),
  })));
}
const echoing = (prefix: string) => (s: net.Socket, got: Buffer[]) => s.on('data', (d: Buffer) => { got.push(d); s.write(Buffer.concat([Buffer.from(prefix), d])); });

beforeAll(async () => {
  own = await generateCACertificate({ subject: { commonName: 'localhost' } });
  echo = await server(echoing('E:'));
  tlsEcho = await server(echoing('T:'), own);
  // Answers the first chunk and closes the connection.
  closer = await server((s, got) => s.once('data', (d: Buffer) => { got.push(d); s.end('BYE'); }));
}, 60_000);
afterAll(() => { echo?.close(); tlsEcho?.close(); closer?.close(); });

const D = 'proxy:s:127.0.0.1';

// Seed a captured stream session with the given frames (bytes as given).
function seedStream(store: Store, wsId: string, kind: 'tcp' | 'tls', stream: StreamInfo, frames: { dir: 'in' | 'out'; bytes: Buffer }[]): void {
  store.addWsSession({ wsId, deviceId: D, source: 'proxy', url: `${kind}://${stream.host}:${stream.port}`, openedAt: 1, kind, httpEntryKey: null, stream });
  let ts = 2;
  for (const f of frames) {
    const binary = f.bytes.includes(0);
    store.appendWsFrame(wsId, { ts: ts++, direction: f.dir, data: binary ? null : f.bytes.toString('utf8'), size: f.bytes.length, binary }, f.bytes, D);
  }
}

const tcpStream = (port: number): StreamInfo => ({ host: '127.0.0.1', port, sni: null, plaintext: true });
const okResult = (r: StreamReplayResult) => { if (!r.ok) throw new Error(`replay failed ${r.code}: ${r.message}`); return r; };

function sessionFrames(store: Store, wsId: string): { dir: string; text: string }[] {
  return store.wsFramesPage(D, wsId, null)!.items.map((f) => ({ dir: f.direction, text: Buffer.from(store.frameBody(D, wsId, f.sequence)!.bytes!).toString('latin1') }));
}

describe('stream replay: tcp', () => {
  it('re-sends every client frame in order and records the echo as a new replay session', async () => {
    const store = new Store();
    seedStream(store, 'w1', 'tcp', tcpStream(echo.port), [
      { dir: 'out', bytes: Buffer.from('\x01one') }, { dir: 'in', bytes: Buffer.from('ignored') }, { dir: 'out', bytes: Buffer.from('two') },
    ]);
    const r = okResult(await performStreamReplay(store, { deviceId: D, wsId: 'w1', timeoutMs: 400 }));
    expect(r).toMatchObject({ closedBy: 'timeout', bytesSent: 7, stored: true, error: null });
    // The two writes may reach the echo as one segment or two.
    expect([9, 11]).toContain(r.bytesReceived);
    expect(r.key.deviceId).toBe(D);
    expect(r.key.wsId).toMatch(/^replay-/);
    const s = store.wsSummaryPage(null, undefined, undefined, 'tcp').items.find((x) => x.wsId === r.key.wsId)!;
    expect(s).toMatchObject({
      source: 'replay', kind: 'tcp', url: `tcp://127.0.0.1:${echo.port}`, closeReason: 'timeout',
      stream: { host: '127.0.0.1', port: echo.port, sni: null, plaintext: true, replayOf: { wsId: 'w1' } },
    });
    const frames = sessionFrames(store, r.key.wsId);
    expect(frames.filter((f) => f.dir === 'out').map((f) => f.text)).toEqual(['\x01one', 'two']);
    expect(frames.filter((f) => f.dir === 'in').map((f) => f.text).join('').replace(/E:/g, '')).toBe('\x01onetwo');
    // The original session is untouched.
    expect(store.wsFramesPage(D, 'w1', null)!.items).toHaveLength(3);
  }, 20_000);

  it('stops when the server closes (closedBy server)', async () => {
    const store = new Store();
    seedStream(store, 'w1', 'tcp', tcpStream(closer.port), [{ dir: 'out', bytes: Buffer.from('HELLO') }]);
    const r = okResult(await performStreamReplay(store, { deviceId: D, wsId: 'w1', timeoutMs: 5000 }));
    expect(r).toMatchObject({ closedBy: 'server', bytesSent: 5, bytesReceived: 3 });
    expect(r.durationMs).toBeLessThan(4000);
    expect(sessionFrames(store, r.key.wsId)).toEqual([{ dir: 'out', text: 'HELLO' }, { dir: 'in', text: 'BYE' }]);
  }, 20_000);

  it('sends only the selected frames, with overrides replacing their payloads', async () => {
    const store = new Store();
    seedStream(store, 'w1', 'tcp', tcpStream(echo.port), [
      { dir: 'out', bytes: Buffer.from('a') }, { dir: 'out', bytes: Buffer.from('b') }, { dir: 'out', bytes: Buffer.from('c') },
    ]);
    const before = echo.received().length;
    const r = okResult(await performStreamReplay(store, { deviceId: D, wsId: 'w1', frames: [2, 0], timeoutMs: 300 }));
    expect(sessionFrames(store, r.key.wsId).filter((f) => f.dir === 'out').map((f) => f.text)).toEqual(['c', 'a']);
    const bin = Buffer.from([0x00, 0xde, 0xad, 0xbe, 0xef]);
    const r2 = okResult(await performStreamReplay(store, { deviceId: D, wsId: 'w1', frames: [1], overrides: { framesBase64: [bin.toString('base64')] }, timeoutMs: 300 }));
    expect(r2.bytesSent).toBe(5);
    expect(echo.received().subarray(before).toString('latin1')).toBe('ca' + bin.toString('latin1'));
    const out = store.wsFramesPage(D, r2.key.wsId, null)!.items.find((f) => f.direction === 'out')!;
    expect(out.binary).toBe(true);
    expect(Buffer.from(store.frameBody(D, r2.key.wsId, out.sequence)!.bytes!)).toEqual(bin);
  }, 20_000);

  it('caps what it reads (closedBy cap) and honours the destination override', async () => {
    const store = new Store();
    seedStream(store, 'w1', 'tcp', tcpStream(1), [{ dir: 'out', bytes: Buffer.from('0123456789') }]);
    const r = okResult(await performStreamReplay(store, { deviceId: D, wsId: 'w1', host: '127.0.0.1', port: echo.port, readBytes: 4, timeoutMs: 5000 }));
    expect(r).toMatchObject({ closedBy: 'cap', bytesReceived: 4 });
    expect(sessionFrames(store, r.key.wsId).filter((f) => f.dir === 'in').map((f) => f.text).join('')).toBe('E:01');
  }, 20_000);

  it('records a connection failure as a closed session with the error', async () => {
    const store = new Store();
    const dead = await server(() => {}); dead.close(); // a port nothing listens on any more
    seedStream(store, 'w1', 'tcp', tcpStream(dead.port), [{ dir: 'out', bytes: Buffer.from('x') }]);
    const r = okResult(await performStreamReplay(store, { deviceId: D, wsId: 'w1', timeoutMs: 3000 }));
    expect(r).toMatchObject({ closedBy: 'error', error: 'ECONNREFUSED', bytesSent: 0 });
    expect(store.wsSummaryPage(null).items.find((s) => s.wsId === r.key.wsId)!.closeReason).toBe('error ECONNREFUSED');
  }, 20_000);
});

describe('stream replay: tls', () => {
  const tlsStream = (): StreamInfo => ({ host: 'localhost', port: tlsEcho.port, sni: 'localhost', plaintext: true });

  it('replays over TLS with the SNI, verifying the upstream certificate', async () => {
    const store = new Store();
    seedStream(store, 'w1', 'tls', tlsStream(), [{ dir: 'out', bytes: Buffer.from('\x02PING') }]);
    const r = okResult(await performStreamReplay(store, { deviceId: D, wsId: 'w1', timeoutMs: 400 }, { tlsOptions: { ca: own.cert } }));
    expect(r).toMatchObject({ closedBy: 'timeout', bytesSent: 5, bytesReceived: 7 });
    const s = store.wsSummaryPage(null).items.find((x) => x.wsId === r.key.wsId)!;
    expect(s).toMatchObject({ kind: 'tls', stream: { sni: 'localhost', replayOf: { wsId: 'w1' } } });
    expect(sessionFrames(store, r.key.wsId)).toEqual([{ dir: 'out', text: '\x02PING' }, { dir: 'in', text: 'T:\x02PING' }]);
    // Without the private CA the upstream certificate is refused (no insecure mode).
    const bad = okResult(await performStreamReplay(store, { deviceId: D, wsId: 'w1', timeoutMs: 3000 }));
    expect(bad.closedBy).toBe('error');
    expect(bad.error).toMatch(/SELF_SIGNED|CERT/);
    expect(bad.bytesSent).toBe(0);
  }, 20_000);

  it('can replay a captured tcp stream over TLS (tls: true) and a tls one in clear (tls: false)', async () => {
    const store = new Store();
    seedStream(store, 'w1', 'tcp', tcpStream(tlsEcho.port), [{ dir: 'out', bytes: Buffer.from('up') }]);
    const r = okResult(await performStreamReplay(store, { deviceId: D, wsId: 'w1', tls: true, sni: 'localhost', timeoutMs: 400 }, { tlsOptions: { ca: own.cert } }));
    expect(r.bytesReceived).toBe(4);
    expect(store.wsSummaryPage(null).items.find((x) => x.wsId === r.key.wsId)!.kind).toBe('tls');
    seedStream(store, 'w2', 'tls', { host: '127.0.0.1', port: echo.port, sni: 'x.test', plaintext: true }, [{ dir: 'out', bytes: Buffer.from('down') }]);
    const r2 = okResult(await performStreamReplay(store, { deviceId: D, wsId: 'w2', tls: false, timeoutMs: 300 }));
    expect(r2.bytesReceived).toBe(6);
    expect(store.wsSummaryPage(null).items.find((x) => x.wsId === r2.key.wsId)).toMatchObject({ kind: 'tcp', stream: { sni: null } });
  }, 20_000);
});

describe('stream replay: refusals', () => {
  const store = new Store();
  beforeAll(() => {
    seedStream(store, 'tunnel', 'tls', { host: 'pinned.test', port: 443, sni: 'pinned.test', plaintext: false }, []);
    seedStream(store, 'starttls', 'tcp', tcpStream(echo.port), [
      { dir: 'out', bytes: Buffer.from('EHLO x\r\n') }, { dir: 'in', bytes: Buffer.from('250 ok\r\n') }, { dir: 'out', bytes: Buffer.from('STARTTLS\r\n') },
      { dir: 'in', bytes: Buffer.from('220 go\r\n') }, { dir: 'out', bytes: Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x01]) },
    ]);
    seedStream(store, 'plain', 'tcp', tcpStream(echo.port), [{ dir: 'out', bytes: Buffer.from('a') }, { dir: 'in', bytes: Buffer.from('b') }]);
    store.addWsSession({ wsId: 'ws', deviceId: D, source: 'proxy', url: 'wss://x.test/', openedAt: 1 });
  });
  const call = (body: unknown) => performStreamReplay(store, body);
  const expectBad = async (body: unknown, code: number, msg: RegExp) => {
    const r = await call(body);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe(code); expect(r.message).toMatch(msg); }
  };

  it('422 for a pass-through tunnel (no plaintext captured)', () => expectBad({ deviceId: D, wsId: 'tunnel' }, 422, /pass-through/));
  it('422 for a STARTTLS-like capture, explaining why', () => expectBad({ deviceId: D, wsId: 'starttls' }, 422, /switched to TLS mid-stream.*frame 4/));
  it('422 for a WebSocket session', () => expectBad({ deviceId: D, wsId: 'ws' }, 422, /not a raw TCP\/TLS stream/));
  it('404 for an unknown session', () => expectBad({ deviceId: D, wsId: 'nope' }, 404, /not found/));
  it('400 for a server frame in the selection', () => expectBad({ deviceId: D, wsId: 'plain', frames: [1] }, 400, /frame 1 is not a retained client-to-server frame/));
  it('400 when overrides do not match the selection', () => expectBad({ deviceId: D, wsId: 'plain', overrides: { framesBase64: ['YQ==', 'Yg=='] } }, 400, /one per selected frame/));
  it('400 for bad base64', () => expectBad({ deviceId: D, wsId: 'plain', overrides: { framesBase64: ['***'] } }, 400, /standard base64/));
  it('400 for a timeout over 30 s and a bad readBytes', async () => {
    await expectBad({ deviceId: D, wsId: 'plain', timeoutMs: 30_001 }, 400, /timeoutMs/);
    await expectBad({ deviceId: D, wsId: 'plain', readBytes: 0 }, 400, /readBytes/);
    await expectBad({ deviceId: D, wsId: 'plain', frames: 'all' }, 400, /frames/);
    await expectBad({ deviceId: D }, 400, /wsId/);
  });
  it('413 for an override frame over the per-frame cap', () =>
    expectBad({ deviceId: D, wsId: 'plain', overrides: { framesBase64: [Buffer.alloc(1024 * 1024 + 1).toString('base64')] } }, 413, /per-frame cap/));
  it('422 for a metadata-range destination, literal or resolved', async () => {
    await expectBad({ deviceId: D, wsId: 'plain', host: '169.254.169.254', port: 80 }, 422, /metadata range/);
    const r = await performStreamReplay(store, { deviceId: D, wsId: 'plain', host: 'evil.test' }, { lookup: async () => [{ address: '169.254.169.254', family: 4 }] });
    expect(r).toMatchObject({ ok: false, code: 422 });
  });
  it('422 for every spelling of the metadata service (name, NAT64, mapped, numeric)', async () => {
    const lookup = async () => { throw new Error('must not resolve'); };
    for (const host of ['metadata.google.internal', '64:ff9b::a9fe:a9fe', '[::ffff:a9fe:a9fe]', '0xa9fea9fe']) {
      const r = await performStreamReplay(store, { deviceId: D, wsId: 'plain', host, port: 80 }, { lookup });
      expect(r, host).toMatchObject({ ok: false, code: 422 });
    }
    const viaDns = await performStreamReplay(store, { deviceId: D, wsId: 'plain', host: 'evil.test' }, { lookup: async () => [{ address: '64:ff9b::a9fe:a9fe', family: 6 }] });
    expect(viaDns).toMatchObject({ ok: false, code: 422 });
  });
  it('422 when a selected frame payload was not retained', async () => {
    const s = new Store({ limits: { perWsMessageBytes: 4 } });
    seedStream(s, 'big', 'tcp', tcpStream(echo.port), [{ dir: 'out', bytes: Buffer.from('0123456789') }]);
    const r = await performStreamReplay(s, { deviceId: D, wsId: 'big' });
    expect(r).toMatchObject({ ok: false, code: 422 });
    if (!r.ok) expect(r.message).toMatch(/not retained \(size\)/);
  });
});

describe('stream replay helpers', () => {
  it('detects a TLS handshake record and the metadata range', () => {
    expect(looksLikeTlsHandshake(Buffer.from([0x16, 0x03, 0x01, 0x02]))).toBe(true);
    expect(looksLikeTlsHandshake(Buffer.from('EHLO'))).toBe(false);
    expect(isMetadataRange('169.254.169.254')).toBe(true);
    expect(isMetadataRange('169.254.1.2')).toBe(true);
    expect(isMetadataRange('::ffff:169.254.169.254')).toBe(true);
    expect(isMetadataRange('fd00:ec2:0::254')).toBe(true);
    expect(isMetadataRange('10.0.0.1')).toBe(false);
    expect(isMetadataRange('::1')).toBe(false);
    expect(isMetadataRange('::ffff:a9fe:a9fe')).toBe(true);
    expect(isMetadataRange('64:ff9b::a9fe:a9fe')).toBe(true);
  });
});

describe('POST /api/replay/stream (route)', () => {
  it('201 with the new key for an admin bearer; a cookie needs an exact Origin', async () => {
    const h = await createCollectorHarness();
    try {
      seedStream(h.store, 'w1', 'tcp', tcpStream(echo.port), [{ dir: 'out', bytes: Buffer.from('hi') }]);
      const body = JSON.stringify({ deviceId: D, wsId: 'w1', timeoutMs: 200 });
      const res = await fetch(`${h.url}/api/replay/stream`, { method: 'POST', headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' }, body });
      expect(res.status).toBe(201);
      const j = await res.json() as { key: { deviceId: string; wsId: string }; closedBy: string; bytesReceived: number; stored: boolean };
      expect(j).toMatchObject({ closedBy: 'timeout', bytesReceived: 4, stored: true, key: { deviceId: D } });
      expect('ok' in j).toBe(false);
      const cookie = await h.login();
      const noOrigin = await fetch(`${h.url}/api/replay/stream`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body });
      expect(noOrigin.status).toBe(403);
      const bad = await fetch(`${h.url}/api/replay/stream`, { method: 'POST', headers: { authorization: `Bearer ${h.adminToken}` }, body: '{' });
      expect(bad.status).toBe(400);
      // The kind filter on /api/ws.
      const list = await fetch(`${h.url}/api/ws?kind=tcp`, { headers: { authorization: `Bearer ${h.adminToken}` } });
      expect(((await list.json()) as { items: { source: string }[] }).items.map((s) => s.source).sort()).toEqual(['proxy', 'replay']);
      const badKind = await fetch(`${h.url}/api/ws?kind=udp`, { headers: { authorization: `Bearer ${h.adminToken}` } });
      expect(badKind.status).toBe(400);
    } finally { await h.close(); }
  }, 20_000);
});
