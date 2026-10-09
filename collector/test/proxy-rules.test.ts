import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { generateCACertificate } from 'mockttp';
import { Store } from '../src/store.js';
import { createProxySource, type ProxySource, type CollectorEndpoint } from '../src/proxy/server.js';
import { createRuleRunner } from '../src/proxy/rules.js';
import { RulesStore } from '../src/rulesStore.js';
import { validateRulesBody, type Rule } from '../src/ruleModel.js';
import { writeHar } from '../src/har.js';
import { loadCaptureDoc } from '../src/loadCapture.js';
import type { Entry } from '../src/types.js';
import type { CompletedRequest } from 'mockttp';

// U6: interception rules applied by the real proxy against local upstreams. Every
// request goes through the proxy in absolute form (plain HTTP) unless the test
// says otherwise; the upstream records what it actually received.

type Hit = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
type Upstream = { port: number; hits: Hit[]; close: () => void; release: () => void };
let up: Upstream;
let other: Upstream;
let CA: { key: string; cert: string };
let tlsUp: { port: number; close: () => void };

async function startUpstream(tag: string): Promise<Upstream> {
  const hits: Hit[] = [];
  let release: () => void = () => {};
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url?.startsWith('/stream')) {
        // A response that only ends when the test says so: a buffered proxy would
        // never deliver its first chunk.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: first\n\n');
        release = () => res.end('data: last\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': tag, 'x-drop': 'me' });
      res.end(JSON.stringify({ from: tag, path: req.url, greeting: 'hello world' }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { port: (srv.address() as AddressInfo).port, hits, close: () => { srv.closeAllConnections(); srv.close(); }, release: () => release() };
}

beforeAll(async () => {
  CA = await generateCACertificate();
  up = await startUpstream('main');
  other = await startUpstream('other');
  const own = await generateCACertificate({ subject: { commonName: 'localhost' } });
  const srv = https.createServer({ key: own.key, cert: own.cert }, (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`tls upstream ${req.url}`); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  tlsUp = { port: (srv.address() as AddressInfo).port, close: () => srv.close() };
}, 60_000);
afterAll(() => { up?.close(); other?.close(); tlsUp?.close(); });

function rules(list: unknown[]): Rule[] {
  const v = validateRulesBody({ rules: list.map((r, i) => ({ id: `r${i}`, name: `rule ${i}`, match: {}, ...(r as object) })) });
  if (!v.ok) throw new Error(`${v.path}: ${v.message}`);
  return v.value;
}

async function withProxy<T>(
  list: unknown[],
  fn: (p: ProxySource, store: Store, rs: RulesStore) => Promise<T>,
  opts: { allow?: string[]; excluded?: CollectorEndpoint[]; passthrough?: string[] } = {},
): Promise<T> {
  const store = new Store();
  const rs = new RulesStore(rules(list));
  const proxy = createProxySource({
    port: 0, ca: CA, store, deviceAllowlist: opts.allow ?? ['127.0.0.1'], excludedCollectorEndpoints: opts.excluded ?? [],
    // The TLS upstream is on loopback (TERMINUS_PROXY_ALLOW_LOCAL=1).
    tlsPassthrough: opts.passthrough, rules: rs, allowLocalDestinations: true,
  });
  await proxy.start();
  try { return await fn(proxy, store, rs); } finally { await proxy.stop(); }
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string; error?: string; ms: number };
function send(proxyPort: number, o: { method?: string; url: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  const t0 = Date.now();
  const target = new URL(o.url);
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: o.method ?? 'GET', path: o.url, headers: { host: target.host, ...(o.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0 }));
      res.on('error', (e) => resolve({ status: 0, headers: {}, body: '', error: (e as NodeJS.ErrnoException).code ?? e.message, ms: Date.now() - t0 }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: '', error: (e as NodeJS.ErrnoException).code ?? e.message, ms: Date.now() - t0 }));
    if (o.body) req.write(o.body);
    req.end();
  });
}

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

const finished = (store: Store): Entry[] => store.entries().filter((e) => e.status != null || e.error != null);
async function onlyEntry(store: Store): Promise<Entry> {
  await waitFor(() => finished(store).length === 1);
  return finished(store)[0];
}
const hitsSince = (u: Upstream, n: number): Hit[] => u.hits.slice(n);

describe('request-phase block', () => {
  it('answers 403 (default) without contacting upstream and records the rule', async () => {
    await withProxy([{ phase: 'request', match: { path: '/ads/*' }, action: { type: 'block' } }], async (p, store) => {
      const before = up.hits.length;
      const r = await send(p.port, { url: `http://127.0.0.1:${up.port}/ads/banner` });
      expect(r.status).toBe(403);
      expect(hitsSince(up, before)).toEqual([]);
      const e = await onlyEntry(store);
      expect(e).toMatchObject({ status: 403, mocked: true, rules: [{ id: 'r0', name: 'rule 0', action: 'block', phase: 'request' }] });
      expect(e.originalUrl).toBeUndefined();
    });
  });

  it('answers a custom status and body', async () => {
    await withProxy([{ phase: 'request', action: { type: 'block', status: 451, body: 'blocked by QA' } }], async (p, store) => {
      const r = await send(p.port, { url: `http://127.0.0.1:${up.port}/x` });
      expect(r).toMatchObject({ status: 451, body: 'blocked by QA' });
      const e = await onlyEntry(store);
      expect(e).toMatchObject({ status: 451, responseBody: 'blocked by QA', mocked: true });
    });
  });

  it('close and reset drop the connection; the entry is an aborted, mocked one', async () => {
    for (const action of [{ type: 'block', close: true }, { type: 'block', reset: true }]) {
      await withProxy([{ phase: 'request', action }], async (p, store) => {
        const before = up.hits.length;
        const r = await send(p.port, { url: `http://127.0.0.1:${up.port}/x` });
        expect(r.status).toBe(0);
        expect(r.error).toBeTruthy();
        expect(hitsSince(up, before)).toEqual([]);
        const e = await onlyEntry(store);
        expect(e.status).toBeNull();
        expect(e.error).toMatch(/^aborted/);
        expect(e).toMatchObject({ mocked: true, rules: [{ action: 'block' }] });
      });
    }
  });
});

describe('request-phase mock', () => {
  it('serves status, headers and body with no upstream hit; the entry holds the mocked response', async () => {
    await withProxy([{ phase: 'request', match: { methods: ['POST'], path: '/login' }, action: { type: 'mock', status: 201, headers: { 'Content-Type': 'application/json', 'X-Mock': '1' }, body: '{"token":"fake"}' } }], async (p, store) => {
      const before = up.hits.length;
      const r = await send(p.port, { method: 'POST', url: `http://127.0.0.1:${up.port}/login`, body: '{"user":"qa"}', headers: { 'content-type': 'application/json' } });
      expect(r.status).toBe(201);
      expect(r.headers['x-mock']).toBe('1');
      expect(r.body).toBe('{"token":"fake"}');
      expect(hitsSince(up, before)).toEqual([]);
      const e = await onlyEntry(store);
      expect(e).toMatchObject({ method: 'POST', status: 201, mocked: true, requestBody: '{"user":"qa"}', rules: [{ id: 'r0', action: 'mock' }] });
      // The stored token was redacted like any captured body.
      expect(e.responseBody).toBe('{"token":"***"}');
      expect(e.responseHeaders['x-mock']).toBe('1');
      expect(e.redacted?.response).toBe(true);
    });
  });

  it('serves a binary bodyBase64 and honours delayMs', async () => {
    await withProxy([{ phase: 'request', action: { type: 'mock', status: 200, headers: { 'content-type': 'application/octet-stream' }, bodyBase64: Buffer.from([0, 1, 2, 255]).toString('base64'), delayMs: 120 } }], async (p) => {
      const t0 = Date.now();
      const raw = await new Promise<Buffer>((resolve) => {
        http.get({ host: '127.0.0.1', port: p.port, path: `http://127.0.0.1:${up.port}/bin`, headers: { host: `127.0.0.1:${up.port}` } }, (res) => {
          const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => resolve(Buffer.concat(c)));
        });
      });
      expect([...raw]).toEqual([0, 1, 2, 255]);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
    });
  });

  it('a mock over HTTPS (MITM) matches on scheme', async () => {
    await withProxy([{ phase: 'request', match: { scheme: 'https', host: 'localhost' }, action: { type: 'mock', status: 200, body: 'mocked tls' } }], async (p, store) => {
      const body = await new Promise<string>((resolve) => {
        const c = http.request({ host: '127.0.0.1', port: p.port, method: 'CONNECT', path: `localhost:${tlsUp.port}` });
        c.on('connect', (_res, socket) => {
          const t = tls.connect({ socket, servername: 'localhost', rejectUnauthorized: false }, () => {
            let b = '';
            t.on('data', (d) => { b += d; });
            t.on('end', () => resolve(b));
            t.write(`GET /x HTTP/1.1\r\nHost: localhost:${tlsUp.port}\r\nConnection: close\r\n\r\n`);
          });
        });
        c.end();
      });
      expect(body).toContain('mocked tls');
      const e = await onlyEntry(store);
      expect(e).toMatchObject({ url: `https://localhost:${tlsUp.port}/x`, mocked: true });
    });
  }, 20_000);
});

describe('request-phase rewrite', () => {
  it('upstream sees the rewritten method, path, headers and body; the entry records what was sent', async () => {
    await withProxy([
      { phase: 'request', match: { path: '/v1/*' }, action: { type: 'rewrite', method: 'PUT', url: '/v2/users?x=1', setHeaders: { 'X-Env': 'qa' }, removeHeaders: ['x-remove'] } },
      { phase: 'request', action: { type: 'rewrite', replace: [{ find: 'alice', with: 'bob' }, { find: '1', with: '2' }] } },
    ], async (p, store) => {
      const before = up.hits.length;
      const sentBody = '{"name":"alice","n":1,"m":"alice"}';
      const r = await send(p.port, { method: 'POST', url: `http://127.0.0.1:${up.port}/v1/users`, body: sentBody, headers: { 'content-type': 'application/json', 'content-length': String(sentBody.length), 'x-remove': 'gone' } });
      expect(r.status).toBe(200);
      const [hit] = hitsSince(up, before);
      expect(hit).toMatchObject({ method: 'PUT', url: '/v2/users?x=1', body: '{"name":"bob","n":2,"m":"bob"}' });
      expect(hit.headers['x-env']).toBe('qa');
      expect(hit.headers['x-remove']).toBeUndefined();
      // The framing follows the new body.
      expect(hit.headers['content-length']).toBe(String(Buffer.byteLength(hit.body)));
      const e = await onlyEntry(store);
      expect(e).toMatchObject({
        method: 'PUT', url: `http://127.0.0.1:${up.port}/v2/users?x=1`, requestBody: '{"name":"bob","n":2,"m":"bob"}',
        originalMethod: 'POST', originalUrl: `http://127.0.0.1:${up.port}/v1/users`,
        rules: [{ id: 'r0', action: 'rewrite', phase: 'request' }, { id: 'r1', action: 'rewrite', phase: 'request' }],
      });
      expect(e.mocked).toBeUndefined();
      expect(e.requestHeaders['x-env']).toBe('qa');
      expect(e.requestHeaders['x-remove']).toBeUndefined();
      expect(e.requestHeaders['content-length']).toBe(String(Buffer.byteLength(hit.body)));
    });
  });

  it('an absolute URL rewrite goes to the other host with a matching Host header', async () => {
    await withProxy([{ phase: 'request', action: { type: 'rewrite', url: `http://127.0.0.1:${other.port}/elsewhere` } }], async (p, store) => {
      const beforeMain = up.hits.length; const beforeOther = other.hits.length;
      const r = await send(p.port, { url: `http://127.0.0.1:${up.port}/here` });
      expect(JSON.parse(r.body).from).toBe('other');
      expect(hitsSince(up, beforeMain)).toEqual([]);
      const [hit] = hitsSince(other, beforeOther);
      expect(hit.url).toBe('/elsewhere');
      expect(hit.headers.host).toBe(`127.0.0.1:${other.port}`);
      const e = await onlyEntry(store);
      expect(e.url).toBe(`http://127.0.0.1:${other.port}/elsewhere`);
      expect(e.requestHeaders.host).toBe(`127.0.0.1:${other.port}`);
      expect(e.originalUrl).toBe(`http://127.0.0.1:${up.port}/here`);
    });
  });

  it('a rewrite to a collector-internal endpoint is refused (connection closed)', async () => {
    await withProxy([{ phase: 'request', action: { type: 'rewrite', url: `http://127.0.0.1:${other.port}/admin` } }], async (p) => {
      const before = other.hits.length;
      const r = await send(p.port, { url: `http://127.0.0.1:${up.port}/x` });
      expect(r.status).toBe(0);
      expect(hitsSince(other, before)).toEqual([]);
    }, { excluded: [{ host: '127.0.0.1', port: other.port }] });
  });

  it('stored URLs stay redacted: the sent URL and originalUrl both mask credentials', async () => {
    await withProxy([{ phase: 'request', action: { type: 'rewrite', url: '/next?token=sent-secret' } }], async (p, store) => {
      await send(p.port, { url: `http://127.0.0.1:${up.port}/x?api_key=orig-secret` });
      const e = await onlyEntry(store);
      expect(e.url).toBe(`http://127.0.0.1:${up.port}/next?token=***`);
      expect(e.originalUrl).toBe(`http://127.0.0.1:${up.port}/x?api_key=***`);
      // (The upstream echoes the path it saw in its JSON body, which is not a
      // credential field; only the URLs are asserted here.)
      expect(`${e.url} ${e.originalUrl} ${JSON.stringify(e.requestHeaders)}`).not.toContain('secret');
      expect(e.redacted?.request).toBe(true);
    });
  });
});

describe('response-phase rewrite', () => {
  it('the device sees the rewritten status, headers and body; the entry records what was delivered', async () => {
    await withProxy([
      { phase: 'response', match: { path: '/api/*' }, action: { type: 'rewrite', status: 503, setHeaders: { 'Retry-After': '30' }, removeHeaders: ['x-drop'], replace: [{ find: 'hello', with: 'goodbye' }] } },
    ], async (p, store) => {
      const r = await send(p.port, { url: `http://127.0.0.1:${up.port}/api/greet` });
      expect(r.status).toBe(503);
      expect(r.headers['retry-after']).toBe('30');
      expect(r.headers['x-drop']).toBeUndefined();
      expect(JSON.parse(r.body).greeting).toBe('goodbye world');
      const e = await onlyEntry(store);
      expect(e).toMatchObject({ status: 503, statusText: 'Service Unavailable', rules: [{ id: 'r0', action: 'rewrite', phase: 'response' }] });
      expect(e.responseHeaders['retry-after']).toBe('30');
      expect(e.responseHeaders['x-drop']).toBeUndefined();
      expect(JSON.parse(e.responseBody!).greeting).toBe('goodbye world');
      expect(e.mocked).toBeUndefined();
    });
  });

  it('a body replacement swaps the whole body', async () => {
    await withProxy([{ phase: 'response', action: { type: 'rewrite', body: '[]' } }], async (p, store) => {
      const r = await send(p.port, { url: `http://127.0.0.1:${up.port}/list` });
      expect(r.body).toBe('[]');
      expect((await onlyEntry(store)).responseBody).toBe('[]');
    });
  });

  it('a request that no response rule matches still streams (not buffered)', async () => {
    await withProxy([{ phase: 'response', match: { path: '/api/*' }, action: { type: 'rewrite', body: 'x' } }], async (p) => {
      const first = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('first chunk never arrived: the response was buffered')), 3000);
        http.get({ host: '127.0.0.1', port: p.port, path: `http://127.0.0.1:${up.port}/stream`, headers: { host: `127.0.0.1:${up.port}` } }, (res) => {
          res.once('data', (d: Buffer) => { clearTimeout(timer); resolve(d.toString()); up.release(); });
          res.resume();
        });
      });
      expect(first).toContain('data: first');
    });
  });
});

describe('delay', () => {
  it('request and response delays add up', async () => {
    await withProxy([
      { phase: 'request', action: { type: 'delay', ms: 100 } },
      { phase: 'response', action: { type: 'delay', ms: 100 } },
    ], async (p, store) => {
      const r = await send(p.port, { url: `http://127.0.0.1:${up.port}/slow` });
      expect(r.status).toBe(200);
      expect(r.ms).toBeGreaterThanOrEqual(190);
      const e = await onlyEntry(store);
      expect(e.rules?.map((x) => `${x.phase}:${x.action}`)).toEqual(['request:delay', 'response:delay']);
    });
  });

  it('the accumulated delay per phase is capped at 30 s', async () => {
    const sleep = vi.fn(async () => {});
    const runner = createRuleRunner({
      rules: () => rules([
        { phase: 'request', action: { type: 'delay', ms: 20_000 } },
        { phase: 'request', action: { type: 'delay', ms: 20_000 } },
        { phase: 'request', action: { type: 'mock', status: 200, delayMs: 20_000 } },
      ]),
      refuseDestination: () => false, sleep,
    });
    const req = { id: 'q1', method: 'GET', url: 'http://a.test/x', headers: {}, body: { getDecodedBuffer: async () => Buffer.alloc(0) } } as unknown as CompletedRequest;
    const out = await runner.beforeRequest(req);
    expect(out?.response).toMatchObject({ statusCode: 200 });
    expect(sleep).toHaveBeenCalledWith(30_000);
    expect(runner.take('q1')?.applied.map((a) => a.action)).toEqual(['delay', 'delay', 'mock']);
    expect(runner.take('q1')).toBeUndefined(); // taken once
  });
});

describe('ordering and short-circuit', () => {
  it('rewrites accumulate in order, the first block/mock wins, disabled and non-matching rules are skipped', async () => {
    await withProxy([
      { phase: 'request', action: { type: 'rewrite', setHeaders: { 'x-a': '1' } } },
      { phase: 'request', enabled: false, action: { type: 'block', status: 410 } },
      { phase: 'request', match: { host: 'nomatch.test' }, action: { type: 'block', status: 418 } },
      { phase: 'request', action: { type: 'mock', status: 202, body: 'second wins' } },
      { phase: 'request', action: { type: 'block', status: 409 } },
      { phase: 'response', action: { type: 'rewrite', body: 'never runs' } },
    ], async (p, store) => {
      const r = await send(p.port, { url: `http://127.0.0.1:${up.port}/x` });
      expect(r).toMatchObject({ status: 202, body: 'second wins' });
      const e = await onlyEntry(store);
      expect(e.rules?.map((x) => x.id)).toEqual(['r0', 'r3']);
      expect(e.mocked).toBe(true);
      // The request as it would have been sent (after the rewrite).
      expect(e.requestHeaders['x-a']).toBe('1');
    });
  });

  it('a runtime toggle applies to the next request', async () => {
    await withProxy([{ phase: 'request', action: { type: 'block', status: 403 } }], async (p, store, rs) => {
      expect((await send(p.port, { url: `http://127.0.0.1:${up.port}/x` })).status).toBe(403);
      rs.setEnabled('r0', false);
      expect((await send(p.port, { url: `http://127.0.0.1:${up.port}/x` })).status).toBe(200);
      await waitFor(() => finished(store).length === 2);
      expect(finished(store).find((e) => e.status === 200)?.rules).toBeUndefined();
    });
  });
});

describe('where rules never apply', () => {
  it('collector-internal endpoints are untouched (and still unrecorded)', async () => {
    await withProxy([{ phase: 'request', action: { type: 'block' } }], async (p, store) => {
      const before = up.hits.length;
      const r = await send(p.port, { url: `http://127.0.0.1:${up.port}/internal` });
      expect(r.status).toBe(200);
      expect(hitsSince(up, before)).toHaveLength(1);
      await new Promise((res) => setTimeout(res, 100));
      expect(store.entries()).toEqual([]);
    }, { excluded: [{ host: '127.0.0.1', port: up.port }] });
  });

  it('TLS pass-through tunnels are untouched', async () => {
    await withProxy([{ phase: 'request', action: { type: 'block' } }, { phase: 'response', action: { type: 'rewrite', body: 'x' } }], async (p, store) => {
      const body = await new Promise<string>((resolve) => {
        const c = http.request({ host: '127.0.0.1', port: p.port, method: 'CONNECT', path: `localhost:${tlsUp.port}` });
        c.on('connect', (_res, socket) => {
          const t = tls.connect({ socket, servername: 'localhost', rejectUnauthorized: false }, () => {
            let b = '';
            t.on('data', (d) => { b += d; });
            t.on('end', () => resolve(b));
            t.write(`GET /pinned HTTP/1.1\r\nHost: localhost:${tlsUp.port}\r\nConnection: close\r\n\r\n`);
          });
        });
        c.end();
      });
      expect(body).toContain('tls upstream /pinned');
      await waitFor(() => store.entries().some((e) => e.tunnel?.closedAt != null));
      expect(store.entries().every((e) => e.rules === undefined)).toBe(true);
    }, { passthrough: ['localhost'] });
  }, 20_000);

  it('a client rejected by the allowlist gets the gate, not the rules', async () => {
    await withProxy([{ phase: 'request', action: { type: 'mock', status: 200, body: 'should not be served' } }], async (p, store) => {
      const r = await send(p.port, { url: `http://127.0.0.1:${up.port}/x` });
      expect(r.status).toBe(0);
      expect(r.body).toBe('');
      expect(store.entries()).toEqual([]);
    }, { allow: ['10.9.9.9'] });
  });
});

describe('rule fields on the read DTOs and in exports', () => {
  it('summary DTO and HAR round trip keep rules/mocked/original*', async () => {
    await withProxy([
      { phase: 'request', action: { type: 'rewrite', method: 'PUT', url: '/b' } },
      { phase: 'request', action: { type: 'mock', status: 200, body: 'ok' } },
    ], async (p, store) => {
      await send(p.port, { method: 'POST', url: `http://127.0.0.1:${up.port}/a` });
      const e = await onlyEntry(store);
      const [summary] = store.entrySummaryPage(null).items;
      expect(summary).toMatchObject({ rules: e.rules, mocked: true, originalMethod: 'POST', originalUrl: `http://127.0.0.1:${up.port}/a` });

      const chunks: Buffer[] = [];
      const snap = store.acquireExportSnapshot({});
      await writeHar(snap, new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } }));
      snap.release();
      const doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const imported = new Store();
      loadCaptureDoc(imported, doc, 'rules.har');
      const [back] = imported.entries();
      expect(back).toMatchObject({ rules: e.rules, mocked: true, originalMethod: 'POST', originalUrl: e.originalUrl, method: 'PUT' });
    });
  });
});
