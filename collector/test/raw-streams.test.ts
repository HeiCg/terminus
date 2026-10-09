import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { generateCACertificate } from 'mockttp';
import { Store } from '../src/store.js';
import { createProxySource, type ProxySource } from '../src/proxy/server.js';
import { isBinaryChunk, streamUrl } from '../src/proxy/rawStreams.js';
import type { ScopeConfig } from '../src/scope.js';

// U7: raw TCP/TLS streams relayed by the proxy (mockttp unknown-protocol
// passthrough inside CONNECT/SOCKS tunnels) become `tcp`/`tls` stream sessions.
// Every upstream is local: a plain TCP echo server and a TLS (non-HTTP) echo
// server with its own self-signed certificate.

let CA: { key: string; cert: string };
let own: { key: string; cert: string };
type Echo = { port: number; connections: () => number; close: () => void };
let echo: Echo;
let tlsEcho: Echo;

function echoServer(prefix: string, opts?: { key: string; cert: string }): Promise<Echo> {
  let conns = 0;
  const onSock = (s: net.Socket) => {
    conns++;
    s.on('data', (d) => s.write(Buffer.concat([Buffer.from(prefix), d])));
    s.on('error', () => {});
  };
  const srv = opts ? tls.createServer(opts, onSock) : net.createServer(onSock);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    port: (srv.address() as AddressInfo).port, connections: () => conns, close: () => srv.close(),
  })));
}

beforeAll(async () => {
  CA = await generateCACertificate();
  own = await generateCACertificate({ subject: { commonName: 'localhost' } });
  echo = await echoServer('E:');
  tlsEcho = await echoServer('T:', own);
}, 60_000);
afterAll(() => { echo?.close(); tlsEcho?.close(); });

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withProxy<T>(
  opts: { allow?: string[]; passthrough?: string[]; scope?: ScopeConfig; socks?: boolean },
  fn: (p: ProxySource, store: Store) => Promise<T>,
): Promise<T> {
  const store = new Store(opts.scope ? { scope: opts.scope } : {});
  const proxy = createProxySource({
    port: 0, ca: CA, store, deviceAllowlist: opts.allow ?? ['127.0.0.1'], excludedCollectorEndpoints: [],
    tlsPassthrough: opts.passthrough, socks: opts.socks,
  });
  await proxy.start();
  try { return await fn(proxy, store); } finally { await proxy.stop(); }
}

function connectTunnel(proxyPort: number, target: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
    r.on('connect', (_res, socket) => resolve(socket));
    r.on('error', reject); r.end();
  });
}

// Write each message, pausing so every one is its own chunk (and its echo comes
// back before the next), then end and collect everything the peer sent.
async function talk(sock: net.Socket, msgs: (string | Buffer)[]): Promise<string> {
  let got = '';
  sock.on('data', (d) => { got += d; });
  sock.on('error', () => {});
  for (const m of msgs) { sock.write(m); await sleep(80); }
  sock.end();
  await new Promise<void>((r) => { if (sock.closed) r(); else sock.once('close', () => r()); setTimeout(r, 1000); });
  return got;
}

async function socks5(proxyPort: number, host: string, port: number): Promise<{ sock: net.Socket; reply: Buffer }> {
  const sock = net.connect(proxyPort, '127.0.0.1');
  sock.on('error', () => {});
  await new Promise((r) => sock.once('connect', r));
  sock.write(Buffer.from([5, 1, 0]));
  const greet = await new Promise<Buffer>((r) => { sock.once('data', r); sock.once('close', () => r(Buffer.alloc(0))); });
  if (greet[0] !== 5 || greet[1] !== 0) return { sock, reply: greet };
  const h = Buffer.from(host);
  sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
  const reply = await new Promise<Buffer>((r) => { sock.once('data', r); sock.once('close', () => r(Buffer.alloc(0))); });
  return { sock, reply };
}

async function frameTexts(store: Store, deviceId: string, wsId: string): Promise<{ dir: string; text: string }[]> {
  const page = store.wsFramesPage(deviceId, wsId, null)!;
  return page.items.map((f) => ({ dir: f.direction, text: Buffer.from(store.frameBody(deviceId, wsId, f.sequence)!.bytes!).toString('latin1') }));
}

describe('raw stream capture: plain TCP', () => {
  it('records a CONNECT-tunnelled TCP stream as a tcp session with ordered frames both ways', async () => {
    await withProxy({}, async (proxy, store) => {
      const sock = await connectTunnel(proxy.port, `127.0.0.1:${echo.port}`);
      const got = await talk(sock, ['\x01hello', 'world']);
      expect(got).toBe('E:\x01helloE:world');
      await waitFor(() => store.wsSessions().some((s) => s.closedAt != null));
      const [s] = store.wsSummaryPage(null).items;
      expect(s).toMatchObject({
        kind: 'tcp', source: 'proxy', url: `tcp://127.0.0.1:${echo.port}`, closeReason: 'closed',
        stream: { host: '127.0.0.1', port: echo.port, sni: null, plaintext: true },
      });
      expect(s.deviceId).toMatch(/^proxy:.*:127\.0\.0\.1$/);
      expect(await frameTexts(store, s.deviceId, s.wsId)).toEqual([
        { dir: 'out', text: '\x01hello' }, { dir: 'in', text: 'E:\x01hello' },
        { dir: 'out', text: 'world' }, { dir: 'in', text: 'E:world' },
      ]);
      const frames = store.wsFramesPage(s.deviceId, s.wsId, null)!.items;
      // Monotonic timestamps on the collector clock.
      for (let i = 1; i < frames.length; i++) expect(frames[i].ts).toBeGreaterThanOrEqual(frames[i - 1].ts);
      expect(frames[0].ts).toBeGreaterThanOrEqual(s.openedAt);
      // kind filter on the read API's page.
      expect(store.wsSummaryPage(null, undefined, undefined, 'tcp').items).toHaveLength(1);
      expect(store.wsSummaryPage(null, undefined, undefined, 'websocket').items).toHaveLength(0);
    });
  }, 30_000);

  it('keeps a binary chunk verbatim (not redacted) and marks it binary', async () => {
    await withProxy({}, async (proxy, store) => {
      const sock = await connectTunnel(proxy.port, `127.0.0.1:${echo.port}`);
      const bin = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x41]);
      await talk(sock, [bin]);
      await waitFor(() => store.wsSessions().some((s) => s.closedAt != null));
      const [s] = store.wsSummaryPage(null).items;
      const [f] = store.wsFramesPage(s.deviceId, s.wsId, null)!.items;
      expect(f.binary).toBe(true);
      expect(Buffer.from(store.frameBody(s.deviceId, s.wsId, f.sequence)!.bytes!)).toEqual(bin);
    });
  }, 30_000);

  it('accepts SOCKS5 only when enabled, and records the stream like a CONNECT one', async () => {
    await withProxy({}, async (proxy, store) => {
      const { sock, reply } = await socks5(proxy.port, '127.0.0.1', echo.port);
      expect(reply[0] === 5 && reply[1] === 0).toBe(false); // off by default
      sock.destroy();
      await sleep(100);
      expect(store.wsSessions()).toHaveLength(0);
    });
    await withProxy({ socks: true }, async (proxy, store) => {
      const { sock, reply } = await socks5(proxy.port, '127.0.0.1', echo.port);
      expect([reply[0], reply[1]]).toEqual([5, 0]);
      expect(await talk(sock, ['\x03socks!'])).toBe('E:\x03socks!');
      await waitFor(() => store.wsSessions().some((s) => s.closedAt != null));
      const [s] = store.wsSummaryPage(null).items;
      expect(s).toMatchObject({ kind: 'tcp', stream: { host: '127.0.0.1', port: echo.port, plaintext: true } });
      expect((await frameTexts(store, s.deviceId, s.wsId)).map((f) => f.dir)).toEqual(['out', 'in']);
    });
  }, 30_000);
});

describe('raw stream capture: TLS', () => {
  // mockttp re-dials an intercepted raw TLS stream with Node's DEFAULT trust; the
  // local upstream's self-signed cert is added to it for this test only.
  const canTrust = typeof (tls as unknown as { setDefaultCACertificates?: unknown }).setDefaultCACertificates === 'function';
  it.skipIf(!canTrust)('MITM: a non-HTTP TLS stream is a tls session with plaintext frames and the SNI', async () => {
    const t = tls as unknown as { setDefaultCACertificates(c: string[]): void; getCACertificates(k: string): string[] };
    const before = t.getCACertificates('default');
    t.setDefaultCACertificates([...before, own.cert]);
    try {
      await withProxy({}, async (proxy, store) => {
        const raw = await connectTunnel(proxy.port, `localhost:${tlsEcho.port}`);
        const sock = tls.connect({ socket: raw, servername: 'localhost', rejectUnauthorized: false });
        await new Promise((r) => sock.once('secureConnect', r));
        // The client saw the PROXY's certificate: the collector terminated TLS.
        expect(sock.getPeerCertificate().issuer?.CN).toMatch(/Mockttp/);
        expect(await talk(sock, ['\x02PING', 'more'])).toBe('T:\x02PINGT:more');
        await waitFor(() => store.wsSessions().some((s) => s.closedAt != null));
        const [s] = store.wsSummaryPage(null).items;
        expect(s).toMatchObject({ kind: 'tls', url: `tls://localhost:${tlsEcho.port}`, stream: { host: 'localhost', port: tlsEcho.port, sni: 'localhost', plaintext: true } });
        expect(await frameTexts(store, s.deviceId, s.wsId)).toEqual([
          { dir: 'out', text: '\x02PING' }, { dir: 'in', text: 'T:\x02PING' },
          { dir: 'out', text: 'more' }, { dir: 'in', text: 'T:more' },
        ]);
      });
    } finally { t.setDefaultCACertificates(before); }
  }, 30_000);

  it('pass-through host: a tls session with metadata only (plaintext false, no frames)', async () => {
    await withProxy({ passthrough: ['localhost'] }, async (proxy, store) => {
      const raw = await connectTunnel(proxy.port, `localhost:${tlsEcho.port}`);
      const sock = tls.connect({ socket: raw, servername: 'localhost', ca: own.cert });
      await new Promise((r) => sock.once('secureConnect', r));
      expect(await talk(sock, ['\x02secret'])).toBe('T:\x02secret');
      await waitFor(() => store.wsSessions().some((s) => s.closedAt != null));
      const [s] = store.wsSummaryPage(null).items;
      expect(s).toMatchObject({ kind: 'tls', totalFrames: 0, stream: { host: 'localhost', port: tlsEcho.port, sni: 'localhost', plaintext: false } });
      // The U5 CONNECT tunnel entry is still recorded beside it.
      expect(store.entries().map((e) => e.method)).toEqual(['CONNECT']);
    });
  }, 30_000);
});

describe('raw stream capture: access boundary and scope', () => {
  it('a client outside the allowlist is closed before any upstream connection', async () => {
    const before = echo.connections();
    await withProxy({ allow: [] }, async (proxy, store) => {
      const sock = await connectTunnel(proxy.port, `127.0.0.1:${echo.port}`);
      const got = await talk(sock, ['\x01nope']);
      expect(got).toBe('');
      await sleep(150);
      expect(echo.connections()).toBe(before);
      expect(store.wsSessions()).toHaveLength(0);
    });
  }, 30_000);

  it('the cloud metadata destination is refused', async () => {
    await withProxy({}, async (proxy, store) => {
      const sock = await connectTunnel(proxy.port, '169.254.169.254:80');
      const closed = new Promise<void>((r) => sock.once('close', () => r()));
      sock.on('error', () => {});
      sock.write('\x01meta');
      await closed;
      await sleep(100);
      expect(store.wsSessions()).toHaveLength(0);
    });
  }, 30_000);

  it('an out-of-scope stream is relayed but not stored (drop counted once)', async () => {
    await withProxy({ scope: { include: ['api.only.test'], exclude: [] } }, async (proxy, store) => {
      const sock = await connectTunnel(proxy.port, `127.0.0.1:${echo.port}`);
      expect(await talk(sock, ['\x01hi', 'again'])).toBe('E:\x01hiE:again');
      await sleep(150);
      expect(store.wsSessions()).toHaveLength(0);
      expect(store.scopeStatus().dropped).toEqual({ excluded: 0, notIncluded: 1 });
    });
  }, 30_000);
});

describe('raw stream helpers', () => {
  it('classifies chunks and builds stream urls', () => {
    expect(isBinaryChunk(Buffer.from('hello'))).toBe(false);
    expect(isBinaryChunk(Buffer.from([0x68, 0x00]))).toBe(true);
    expect(isBinaryChunk(Buffer.from([0xc3, 0x28]))).toBe(true);
    expect(streamUrl('tcp', 'example.com', 25)).toBe('tcp://example.com:25');
    expect(streamUrl('tls', '::1', 443)).toBe('tls://[::1]:443');
  });
});
