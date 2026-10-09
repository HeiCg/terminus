import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { generateCACertificate } from 'mockttp';
import { Store } from '../src/store.js';
import { createProxySource, type ProxySource } from '../src/proxy/server.js';
import { resolveProxyTls } from '../src/proxy/tlsMode.js';
import type { ScopeConfig } from '../src/scope.js';
import { Writable } from 'node:stream';
import { writeHar } from '../src/har.js';
import { loadCaptureDoc } from '../src/loadCapture.js';

// U5: user-configurable TLS pass-through / intercept-only on the proxy, the
// tunnel records they produce, and the capture scope on proxied traffic. Every
// upstream is local: an HTTPS server with its OWN self-signed certificate (CN
// localhost), reached through CONNECT with the SNI the test chooses.

let CA: { key: string; cert: string };
let upstream: { port: number; fp: string; secureConnections: () => number; close: () => void };

beforeAll(async () => {
  CA = await generateCACertificate();
  const own = await generateCACertificate({ subject: { commonName: 'localhost' } });
  let secure = 0;
  const srv = https.createServer({ key: own.key, cert: own.cert }, (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`upstream ${req.url}`); });
  srv.on('secureConnection', () => { secure++; });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  upstream = {
    port: (srv.address() as AddressInfo).port,
    fp: new crypto.X509Certificate(own.cert).fingerprint256,
    secureConnections: () => secure,
    close: () => srv.close(),
  };
}, 60_000);
afterAll(() => upstream?.close());

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function withProxy<T>(
  opts: { allow?: string[]; passthrough?: string[]; interceptOnly?: string[]; scope?: ScopeConfig },
  fn: (p: ProxySource, store: Store) => Promise<T>,
): Promise<T> {
  const store = new Store(opts.scope ? { scope: opts.scope } : {});
  const proxy = createProxySource({
    port: 0, ca: CA, store, deviceAllowlist: opts.allow ?? ['127.0.0.1'], excludedCollectorEndpoints: [],
    tlsPassthrough: opts.passthrough, tlsInterceptOnly: opts.interceptOnly,
  });
  await proxy.start();
  try { return await fn(proxy, store); } finally { await proxy.stop(); }
}

// CONNECT through the proxy to `target`, complete a TLS handshake with
// `servername`, then (when the handshake succeeds) send one GET and read the reply
// so the tunnel carries traffic both ways. Resolves with the certificate the client
// saw ('ERR:...' when the handshake never completed) and the response body.
function tlsThroughProxy(proxyPort: number, target: string, servername?: string): Promise<{ fp: string; body: string }> {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
    r.on('connect', (_res, socket) => {
      const t = tls.connect({ socket, servername, rejectUnauthorized: false }, () => {
        const fp = t.getPeerCertificate().fingerprint256;
        let body = '';
        t.on('data', (d) => { body += d; });
        t.on('end', () => { t.destroy(); resolve({ fp, body }); });
        t.write(`GET /hello HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
      });
      t.on('error', (e) => resolve({ fp: 'ERR:' + e.message, body: '' }));
      t.on('close', () => resolve({ fp: 'ERR:closed', body: '' }));
    });
    r.on('error', (e) => resolve({ fp: 'CERR:' + e.message, body: '' }));
    r.end();
  });
}

function plainThroughProxy(proxyPort: number, targetPort: number, p: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: `http://127.0.0.1:${targetPort}${p}`, headers: { host: `127.0.0.1:${targetPort}` } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', () => resolve(0)); req.end();
  });
}

describe('proxy TLS pass-through (TERMINUS_PROXY_PASSTHROUGH)', () => {
  it('tunnels a listed host without MITM (client sees the upstream certificate) and records the tunnel', async () => {
    await withProxy({ passthrough: ['localhost'] }, async (proxy, store) => {
      const r = await tlsThroughProxy(proxy.port, `localhost:${upstream.port}`, 'localhost');
      expect(r.fp).toBe(upstream.fp);
      expect(r.body).toContain('upstream /hello');
      await waitFor(() => store.entries().some((e) => e.tunnel?.closedAt != null));
      const [e] = store.entries();
      expect(store.entries()).toHaveLength(1); // nothing inside the tunnel is visible
      expect(e).toMatchObject({ source: 'proxy', method: 'CONNECT', url: `https://localhost:${upstream.port}`, status: 200, error: null, requestHeaders: {}, responseHeaders: {} });
      expect(e.tunnel).toMatchObject({ host: 'localhost', port: upstream.port, sni: 'localhost' });
      expect(e.tunnel!.bytesUp).toBeGreaterThan(0);
      expect(e.tunnel!.bytesDown).toBeGreaterThan(0);
      expect(e.tunnel!.closedAt!).toBeGreaterThanOrEqual(e.tunnel!.openedAt);
      expect(e.durationMs).toBe(e.tunnel!.closedAt! - e.tunnel!.openedAt);
      // Visible on the read API's summary DTO too.
      const page = store.entrySummaryPage(null);
      expect(page.items[0].tunnel).toEqual(e.tunnel);
    });
  }, 30_000);

  it('still intercepts a host that is not listed (proxy-signed certificate, normal entry)', async () => {
    await withProxy({ passthrough: ['localhost'] }, async (proxy, store) => {
      const r = await tlsThroughProxy(proxy.port, `127.0.0.1:${upstream.port}`);
      expect(r.fp).not.toBe(upstream.fp);
      expect(r.fp.startsWith('ERR')).toBe(false);
      await waitFor(() => store.entries().some((e) => e.status === 200));
      expect(store.entries().every((e) => e.tunnel === undefined && e.method === 'GET')).toBe(true);
    });
  }, 30_000);

  it('is not an open relay: a client outside the allowlist cannot use a pass-through tunnel', async () => {
    const before = upstream.secureConnections();
    await withProxy({ allow: [], passthrough: ['localhost'] }, async (proxy, store) => {
      const r = await tlsThroughProxy(proxy.port, `localhost:${upstream.port}`, 'localhost');
      expect(r.fp.startsWith('ERR')).toBe(true);
      await new Promise((res) => setTimeout(res, 200));
      expect(upstream.secureConnections()).toBe(before);
      expect(store.entries()).toHaveLength(0);
    });
  }, 30_000);
});

describe('proxy TLS intercept-only (TERMINUS_PROXY_INTERCEPT_ONLY)', () => {
  it('intercepts only the listed hosts and tunnels every other one', async () => {
    await withProxy({ interceptOnly: ['localhost'] }, async (proxy, store) => {
      const tunnelled = await tlsThroughProxy(proxy.port, `127.0.0.1:${upstream.port}`);
      expect(tunnelled.fp).toBe(upstream.fp);
      const intercepted = await tlsThroughProxy(proxy.port, `localhost:${upstream.port}`, 'localhost');
      expect(intercepted.fp).not.toBe(upstream.fp);
      expect(intercepted.fp.startsWith('ERR')).toBe(false);
      await waitFor(() => store.entries().length === 2 && store.entries().every((e) => e.status === 200));
      const byMethod = Object.fromEntries(store.entries().map((e) => [e.method, e]));
      expect(byMethod.CONNECT.tunnel).toMatchObject({ host: '127.0.0.1', port: upstream.port, sni: null });
      expect(byMethod.GET.url).toBe(`https://localhost:${upstream.port}/hello`);
    });
  }, 30_000);

  it('refuses both modes at once', () => {
    expect(() => createProxySource({ port: 0, ca: CA, store: new Store(), deviceAllowlist: [], excludedCollectorEndpoints: [], tlsPassthrough: ['a.test'], tlsInterceptOnly: ['b.test'] }))
      .toThrow(/cannot both be set/);
  });
});

describe('resolveProxyTls (env parsing)', () => {
  const own = ['mac-host', 'localhost', '192.168.1.10'];
  it('defaults when neither is set', () => {
    expect(resolveProxyTls({}, own)).toEqual({ mode: 'default' });
    expect(resolveProxyTls({ passthrough: ' ' }, own)).toEqual({ mode: 'default' });
  });

  it('keeps valid patterns (normalized), skips invalid ones and the metadata address', () => {
    expect(resolveProxyTls({ passthrough: 'Pinned.Bank.example, *.apple.com, https://x.test, a.test:443, 169.254.169.254, a.test/path' }, own))
      .toEqual({ mode: 'passthrough', hosts: ['pinned.bank.example', '*.apple.com'] });
  });

  it('refuses both set, naming the variables', () => {
    expect(() => resolveProxyTls({ passthrough: 'a.test', interceptOnly: 'b.test' }, own)).toThrow(/TERMINUS_PROXY_PASSTHROUGH and TERMINUS_PROXY_INTERCEPT_ONLY cannot both be set/);
  });

  it('intercept-only never lists the collector itself and refuses an empty result', () => {
    expect(resolveProxyTls({ interceptOnly: 'api.app.test,localhost,192.168.1.10' }, own)).toEqual({ mode: 'intercept-only', hosts: ['api.app.test'] });
    expect(() => resolveProxyTls({ interceptOnly: 'localhost, bad:1' }, own)).toThrow(/no usable host pattern/);
  });
});

describe('capture scope on the proxy (recording, not blocking)', () => {
  it('an out-of-scope request still reaches the upstream but is not recorded', async () => {
    let hits = 0;
    const up = http.createServer((_req, res) => { hits++; res.end('ok'); });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
    const upPort = (up.address() as AddressInfo).port;
    try {
      await withProxy({ scope: { include: [], exclude: ['127.0.0.1/skip*'] } }, async (proxy, store) => {
        expect(await plainThroughProxy(proxy.port, upPort, '/skip/me')).toBe(200);
        expect(await plainThroughProxy(proxy.port, upPort, '/keep')).toBe(200);
        await waitFor(() => store.entries().length === 1 && store.entries()[0].status === 200);
        await new Promise((r) => setTimeout(r, 100));
        expect(hits).toBe(2);
        expect(store.entries().map((e) => new URL(e.url).pathname)).toEqual(['/keep']);
        expect(store.scopeStatus().dropped).toEqual({ excluded: 1, notIncluded: 0 });
        // An out-of-scope exchange does not even create the proxy device.
        expect(store.devices()).toHaveLength(1);
      });
    } finally { up.close(); }
  }, 30_000);

  it('a pass-through tunnel out of scope is still tunnelled but not recorded', async () => {
    await withProxy({ passthrough: ['localhost'], scope: { include: ['api.only.test'], exclude: [] } }, async (proxy, store) => {
      const r = await tlsThroughProxy(proxy.port, `localhost:${upstream.port}`, 'localhost');
      expect(r.fp).toBe(upstream.fp);
      await new Promise((res) => setTimeout(res, 200));
      expect(store.entries()).toHaveLength(0);
      expect(store.devices()).toHaveLength(0);
      expect(store.scopeStatus().dropped.notIncluded).toBe(1);
    });
  }, 30_000);
});

describe('tunnel records in exports', () => {
  it('a HAR export carries the tunnel metadata and --load restores it', async () => {
    const store = new Store();
    const tunnel = { host: 'pinned.example', port: 443, sni: 'pinned.example', bytesUp: 1200, bytesDown: 5400, openedAt: 1000, closedAt: 1500 };
    store.addEntryInput({
      id: 'proxy:s:t1', deviceId: 'proxy:s:127.0.0.1', source: 'proxy', startedAt: 1000, method: 'CONNECT', url: 'https://pinned.example:443',
      requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
      status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: null, responseBodySize: 0, responseBodyOmitted: null,
      durationMs: 500, error: null, tunnel,
    });
    const chunks: Buffer[] = [];
    const out = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    const snap = store.acquireExportSnapshot({});
    await writeHar(snap, out);
    const har = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(har.log.entries[0]._terminus.tunnel).toEqual(tunnel);
    const back = new Store();
    loadCaptureDoc(back, har, 'x.har');
    expect(back.entries()[0].tunnel).toEqual(tunnel);
  });
});
