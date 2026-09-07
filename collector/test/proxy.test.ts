import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { generateCACertificate } from 'mockttp';
import { Store } from '../src/store.js';
import { applyAtlantisEvent } from '../src/atlantis/server.js';
import { createProxySource, loadOrCreateProxyCA, normalizeIp, CLOUD_METADATA_IP, type ProxySource } from '../src/proxy/server.js';
import { classifyBody, normalizeHeaders, normalizeWsFrame, buildEntryInput, epochOf } from '../src/proxy/normalize.js';
import type { AtlantisEvent } from '../src/atlantis/decode.js';

// A shared proxy CA for the live-proxy fixtures (generated once; TLS keygen is slow).
let CA: { key: string; cert: string };
beforeAll(async () => { CA = await generateCACertificate(); }, 30_000);

// ---- Local upstream + proxy client helpers --------------------------------

// A controlled local HTTP upstream. Each response echoes the path so a test can
// tell responses apart; the server counts hits so "no dedup" is observable at the
// upstream too.
function startUpstream(): Promise<{ port: number; hits: () => number; close: () => void }> {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`ok ${req.url}`); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    resolve({ port: (srv.address() as import('node:net').AddressInfo).port, hits: () => hits, close: () => srv.close() });
  }));
}

// Issue one HTTP request THROUGH the proxy (absolute-URI form, the classic HTTP
// proxy protocol). `clientIp` is always 127.0.0.1 here; the allowlist tests assert
// what the proxy does with that address.
function throughProxy(proxyPort: number, targetPort: number, targetPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxyPort, method: 'GET',
      path: `http://127.0.0.1:${targetPort}${targetPath}`, headers: { host: `127.0.0.1:${targetPort}` },
    }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); });
    req.on('error', reject); req.end();
  });
}

// A raw absolute-URI WebSocket upgrade through the proxy (the ws:// proxy form).
// Resolves with the response status line, or 'CLOSED' when the proxy refuses the
// upgrade by closing the connection with no response.
function wsUpgradeThroughProxy(proxyPort: number, targetPort: number): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      s.write(`GET http://127.0.0.1:${targetPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = '';
    const done = (v: string) => { resolve(v); s.destroy(); };
    s.on('data', (d) => { buf += d; if (buf.includes('\r\n')) done(buf.split('\r\n')[0]); });
    s.on('close', () => resolve(buf ? buf.split('\r\n')[0] : 'CLOSED'));
    s.on('error', () => resolve('CLOSED'));
    setTimeout(() => done(buf ? buf.split('\r\n')[0] : 'CLOSED'), 1500);
  });
}

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function withProxy<T>(opts: { allow?: string[]; excluded?: { host: string; port: number }[] }, fn: (p: ProxySource, store: Store) => Promise<T>): Promise<T> {
  const store = new Store();
  const proxy = createProxySource({ port: 0, ca: CA, store, deviceAllowlist: opts.allow ?? ['127.0.0.1'], excludedCollectorEndpoints: opts.excluded ?? [] });
  await proxy.start();
  try { return await fn(proxy, store); } finally { await proxy.stop(); }
}

// ---- The two acceptance fixtures (real, live-proxy) ------------------------

// Two identical, legitimate requests to the same URL are two pieces of evidence:
// the proxy source never dedupes by URL/method/body/timestamp.
export async function captureSameUrlTwiceThroughProxy(): Promise<import('../src/types.js').Entry[]> {
  const up = await startUpstream();
  try {
    return await withProxy({}, async (proxy, store) => {
      await throughProxy(proxy.port, up.port, '/same');
      await throughProxy(proxy.port, up.port, '/same');
      await waitFor(() => store.entries().filter((e) => e.source === 'proxy' && e.url.endsWith('/same')).length === 2);
      return store.entries().filter((e) => e.source === 'proxy' && e.url.endsWith('/same'));
    });
  } finally { up.close(); }
}

// The same device seen by Atlantis and by the proxy yields one row per source,
// ordered atlantis-then-proxy. Sources are preserved, never merged.
export async function captureOneRequestFromEachSource(): Promise<{ source: string }[]> {
  const up = await startUpstream();
  try {
    return await withProxy({}, async (proxy, store) => {
      // Atlantis evidence (earlier startedAt so it sorts first).
      const ev: AtlantisEvent = {
        kind: 'traffic', deviceKey: 'dev-1', isWebsocket: false, isSse: false,
        entry: {
          id: 'a1', deviceId: 'dev-1', source: 'atlantis', startedAt: 1000, method: 'GET', url: 'http://127.0.0.1/same',
          requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
          status: 200, statusText: '', responseHeaders: {}, responseBytes: null, responseBodySize: 0, responseBodyOmitted: null,
          durationMs: 1, error: null,
        },
      };
      applyAtlantisEvent(store, ev, 'gen-atl');
      // Proxy evidence (now, so it sorts after).
      await throughProxy(proxy.port, up.port, '/same');
      await waitFor(() => store.entries().length === 2);
      return store.entries().map((e) => ({ source: e.source }));
    });
  } finally { up.close(); }
}

// ---- Acceptance ------------------------------------------------------------

describe('proxy source — acceptance', () => {
  it('captures the same URL twice without dedup (two evidences)', async () => {
    expect(await captureSameUrlTwiceThroughProxy()).toHaveLength(2);
  }, 20_000);

  it('keeps one row per source when atlantis and proxy see the same device', async () => {
    expect(await captureOneRequestFromEachSource()).toMatchObject([{ source: 'atlantis' }, { source: 'proxy' }]);
  }, 20_000);

  it('a client that ignores the proxy produces no proxy evidence', async () => {
    const up = await startUpstream();
    try {
      await withProxy({}, async (_proxy, store) => {
        // Request goes straight to the upstream, bypassing the proxy entirely.
        await new Promise<void>((resolve, reject) => {
          const r = http.request({ host: '127.0.0.1', port: up.port, path: '/direct' }, (res) => { res.resume(); res.on('end', () => resolve()); });
          r.on('error', reject); r.end();
        });
        await new Promise((r) => setTimeout(r, 200));
        expect(up.hits()).toBe(1);
        expect(store.entries()).toHaveLength(0); // proxy saw nothing
      });
    } finally { up.close(); }
  }, 20_000);

  it('proxy start/stop does not disturb Atlantis capture (proxy never gates it)', async () => {
    const store = new Store();
    const proxy = createProxySource({ port: 0, ca: CA, store, deviceAllowlist: ['127.0.0.1'], excludedCollectorEndpoints: [] });
    await proxy.start();
    await proxy.stop(); // proxy off
    // Atlantis still admits traffic after the proxy is gone.
    applyAtlantisEvent(store, {
      kind: 'traffic', deviceKey: 'd', isWebsocket: false, isSse: false,
      entry: { id: 'x', deviceId: 'd', source: 'atlantis', startedAt: 1, method: 'GET', url: 'http://h/', requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null, status: 200, statusText: '', responseHeaders: {}, responseBytes: null, responseBodySize: 0, responseBodyOmitted: null, durationMs: 1, error: null },
    }, 'g');
    expect(store.entries().map((e) => e.source)).toEqual(['atlantis']);
  }, 20_000);
});

// ---- Client allowlist + destination policy (no open relay) -----------------

describe('proxy source — access boundary', () => {
  it('rejects a client outside the allowlist and records nothing', async () => {
    const up = await startUpstream();
    try {
      // Empty allowlist => 127.0.0.1 is not permitted.
      await withProxy({ allow: [] }, async (proxy, store) => {
        const res = await throughProxy(proxy.port, up.port, '/x').catch(() => ({ status: 0, body: '' }));
        // Connection is closed by the gate; nothing reaches the upstream or the store.
        await new Promise((r) => setTimeout(r, 200));
        expect(res.status).not.toBe(200);
        expect(up.hits()).toBe(0);
        expect(store.entries()).toHaveLength(0);
      });
    } finally { up.close(); }
  }, 20_000);

  it('refuses the cloud metadata destination even for an allowed client', async () => {
    await withProxy({ allow: ['127.0.0.1'] }, async (proxy, store) => {
      const res = await new Promise<number>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: `http://${CLOUD_METADATA_IP}/latest/meta-data/`, headers: { host: CLOUD_METADATA_IP } },
          (r) => { r.resume(); resolve(r.statusCode ?? 0); });
        req.on('error', () => resolve(0));
        req.end();
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(res).not.toBe(200);
      expect(store.entries()).toHaveLength(0);
    });
  }, 20_000);

  it('refuses a non-allowlisted WebSocket upgrade at the rule (not relayed)', async () => {
    const up = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => up.on('listening', () => r()));
    const upPort = (up.address() as import('node:net').AddressInfo).port;
    let upstreamConns = 0;
    up.on('connection', () => { upstreamConns++; });
    try {
      // Empty allowlist => 127.0.0.1 is not permitted: the WS upgrade is closed and
      // never reaches the upstream ws server (no open WS relay on the LAN).
      await withProxy({ allow: [] }, async (proxy) => {
        const line = await wsUpgradeThroughProxy(proxy.port, upPort);
        expect(line).not.toContain('101');
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(upstreamConns).toBe(0);
      // An allowlisted client still completes the upgrade.
      await withProxy({ allow: ['127.0.0.1'] }, async (proxy) => {
        const line = await wsUpgradeThroughProxy(proxy.port, upPort);
        expect(line).toContain('101');
      });
      await waitFor(() => upstreamConns === 1);
      expect(upstreamConns).toBe(1);
    } finally { up.close(); }
  }, 30_000);
});

// ---- Collector-internal bypass keeps the collector's pinned certificate ----

describe('proxy source — collector-internal tunnel', () => {
  it('tunnels the collector endpoint raw by hostname (pinned cert stays the collector\'s) and records nothing', async () => {
    // Pick a free port for the excluded upstream by binding to 0 first.
    const probe = https.createServer(); await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as import('node:net').AddressInfo).port; probe.close();
    const collectorCert = await generateCACertificate({ subject: { commonName: 'localhost' } });
    const collectorFp = new crypto.X509Certificate(collectorCert.cert).fingerprint256;
    const up = https.createServer({ key: collectorCert.key, cert: collectorCert.cert }, (_r, res) => { res.writeHead(200); res.end('c'); });
    await new Promise<void>((r) => up.listen(port, '127.0.0.1', () => r()));
    const store = new Store();
    const proxy = createProxySource({ port: 0, ca: CA, store, deviceAllowlist: ['127.0.0.1'], excludedCollectorEndpoints: [{ host: 'localhost', port }] });
    await proxy.start();
    try {
      const peerFp = await new Promise<string>((resolve) => {
        const r = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `localhost:${port}` });
        r.on('connect', (_res, socket) => { const t = tls.connect({ socket, servername: 'localhost', rejectUnauthorized: false }, () => { const pc = t.getPeerCertificate(); t.destroy(); resolve(pc.fingerprint256); }); t.on('error', (e) => resolve('ERR:' + e.message)); });
        r.on('error', (e) => resolve('CERR:' + e.message)); r.end();
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(peerFp).toBe(collectorFp);
      expect(store.entries()).toHaveLength(0);
    } finally { await proxy.stop(); up.close(); }
  }, 30_000);

  it('tunnels the collector endpoint raw when the device dials it by LAN IP', async () => {
    // Free port for the upstream.
    const probe = https.createServer(); await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as import('node:net').AddressInfo).port; probe.close();
    const collectorCert = await generateCACertificate({ subject: { commonName: 'localhost' } });
    const collectorFp = new crypto.X509Certificate(collectorCert.cert).fingerprint256;
    const up = https.createServer({ key: collectorCert.key, cert: collectorCert.cert }, (_r, res) => { res.writeHead(200); res.end('c'); });
    await new Promise<void>((r) => up.listen(port, '127.0.0.1', () => r()));
    const store = new Store();
    // Exclude by IP (as main.ts now does via lanAddresses()). The device dials the IP
    // with no SNI; the tunnel must still be raw (collector's own cert), not MITM'd.
    const proxy = createProxySource({ port: 0, ca: CA, store, deviceAllowlist: ['127.0.0.1'], excludedCollectorEndpoints: [{ host: '127.0.0.1', port }] });
    await proxy.start();
    try {
      const peerFp = await new Promise<string>((resolve) => {
        const r = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `127.0.0.1:${port}` });
        r.on('connect', (_res, socket) => { const t = tls.connect({ socket, rejectUnauthorized: false }, () => { const pc = t.getPeerCertificate(); t.destroy(); resolve(pc.fingerprint256); }); t.on('error', (e) => resolve('ERR:' + e.message)); });
        r.on('error', (e) => resolve('CERR:' + e.message)); r.end();
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(peerFp).toBe(collectorFp); // raw tunnel: NOT proxy-signed
      expect(store.entries()).toHaveLength(0);
    } finally { await proxy.stop(); up.close(); }
  }, 30_000);
});

// ---- Normalization units (redaction + caps BEFORE the store) ---------------

describe('proxy normalize', () => {
  it('classifies absent / text / binary / oversize bodies like the other sources', () => {
    expect(classifyBody(null)).toEqual({ bytes: null, size: 0, omitted: null });
    const text = classifyBody(Buffer.from('hello'));
    expect(text.omitted).toBe(null); expect(text.bytes && Buffer.from(text.bytes).toString()).toBe('hello');
    const bin = classifyBody(Buffer.from([0, 1, 2, 3]));
    expect(bin.omitted).toBe('binary'); expect(bin.bytes).not.toBeNull();
    const over = classifyBody(Buffer.alloc(10), 4);
    expect(over.omitted).toBe('size'); expect(over.bytes).toBeNull(); expect(over.size).toBe(10);
  });

  it('redacts sensitive text in bodies before storing', () => {
    const b = classifyBody(Buffer.from(JSON.stringify({ access_token: 'secret-xyz', ok: 1 })));
    const s = Buffer.from(b.bytes!).toString('utf8');
    expect(s).not.toContain('secret-xyz');
    expect(s).toContain('***');
  });

  it('redacts URL query and sensitive headers in the built entry input', () => {
    const e = buildEntryInput({
      ids: { id: 'proxy:s:r', deviceId: 'proxy:s:c' }, startedAt: 1, method: 'GET',
      url: 'https://h/p?access_token=abc&keep=1',
      requestHeaders: { authorization: 'Bearer t', 'x-keep': 'v', ':method': 'GET' },
    });
    expect(e.source).toBe('proxy');
    expect(e.url).toContain('access_token=***');
    expect(e.url).toContain('keep=1');
    expect(e.requestHeaders.authorization).toBe('***');
    expect(e.requestHeaders['x-keep']).toBe('v');
    expect(Object.keys(e.requestHeaders)).not.toContain(':method');
  });

  it('flattens repeated headers and drops pseudo-headers', () => {
    expect(normalizeHeaders({ 'set-cookie': ['a', 'b'], ':status': '200', x: undefined })).toEqual({ 'set-cookie': 'a\nb' });
  });

  it('maps WS direction (received=out, sent=in) and enforces the 256 KiB cap', () => {
    const inbound = normalizeWsFrame(Buffer.from('hi'), false, 'sent', 5);
    expect(inbound.frame.direction).toBe('in'); expect(inbound.frame.data).toBe('hi');
    const outbound = normalizeWsFrame(Buffer.from('yo'), false, 'received', 5);
    expect(outbound.frame.direction).toBe('out');
    const big = normalizeWsFrame(Buffer.alloc(300 * 1024), true, 'sent', 5, 256 * 1024);
    expect(big.bytes).toBeNull(); expect(big.frame.size).toBe(300 * 1024); expect(big.frame.binary).toBe(true);
  });

  it('anchors monotonic event timestamps to epoch time', () => {
    expect(epochOf({ startTime: 1000, startTimestamp: 500 }, 700)).toBe(1200);
    expect(epochOf({ startTime: 1000 })).toBe(1000);
  });

  it('normalizes IPv4-mapped IPv6 addresses', () => {
    expect(normalizeIp('::ffff:192.168.0.5')).toBe('192.168.0.5');
    expect(normalizeIp('127.0.0.1')).toBe('127.0.0.1');
  });
});

// ---- Proxy CA persistence (private, PEM, separate from TLS identity) --------

describe('proxy CA', () => {
  it('creates a private CA once and re-uses it, exporting the cert as PEM', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-proxy-ca-'));
    try {
      const a = await loadOrCreateProxyCA(dir);
      expect(a.cert).toContain('BEGIN CERTIFICATE');
      expect(a.certPath.endsWith('.pem')).toBe(true);
      const keyStat = await fsp.stat(path.join(dir, 'proxy-ca.key'));
      expect(keyStat.mode & 0o077).toBe(0); // private key not group/other readable
      const b = await loadOrCreateProxyCA(dir);
      expect(b.cert).toBe(a.cert); // stable across restarts
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  }, 30_000);
});
