import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { Entry } from '../src/types.js';
import { safeStaticPath } from '../src/http.js';
import { createCollectorHarness } from './fixtures/harness.js';

function seed(store: import('../src/store.js').Store): Entry {
  const e: Entry = {
    id: 'seed-1', deviceId: 'd1', source: 'xhr', startedAt: 1, method: 'GET', url: 'https://x/y',
    requestHeaders: {}, requestBody: null, requestBodySize: 0, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: {}, responseBody: null, responseBodySize: 0,
    responseBodyOmitted: null, durationMs: 1, error: null,
  };
  store.addEntry(e);
  return e;
}

// Raw request so we can forge a Host header; fetch/undici forbids overriding it.
const rawGet = (url: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); },
    );
    req.on('error', reject);
    req.end();
  });

const upgrade = (base: string, p: string, headers: Record<string, string> = {}) =>
  new Promise<{ ok: boolean; code?: number }>((resolve) => {
    const ws = new WebSocket(base.replace('http', 'ws') + p, { headers });
    ws.on('open', () => { resolve({ ok: true }); ws.close(); });
    ws.on('error', () => resolve({ ok: false }));
    ws.on('unexpected-response', (_req, res) => resolve({ ok: false, code: res.statusCode }));
  });

describe('admin route authentication (R1)', () => {
  it('gates every data/export/clear route behind a session', async () => {
    const h = await createCollectorHarness();
    try {
      seed(h.store);
      for (const p of ['/api/entries', '/api/ws', '/api/devices', '/export.har', '/export.json']) {
        expect((await fetch(h.url + p)).status).toBe(401);
      }
      expect((await fetch(h.url + '/api/clear', { method: 'POST' })).status).toBe(401);
      expect((await fetch(h.url + '/api/pause', { method: 'POST' })).status).toBe(401);
      // The unauthenticated clear must not have touched captured data.
      expect(h.store.entries('d1')).toHaveLength(1);

      const cookie = await h.login();
      expect((await fetch(h.url + '/api/entries', { headers: { cookie } })).status).toBe(200);
      expect((await fetch(h.url + '/api/clear', {
        method: 'POST', headers: { cookie, origin: 'http://evil.test' },
      })).status).toBe(403);
      // Origin was rejected before the mutation ran; the seed survives.
      expect(h.store.entries('d1')).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('serves /health anonymously without capture data', async () => {
    const h = await createCollectorHarness();
    try {
      const res = await fetch(h.url + '/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(typeof body.version).toBe('string');
    } finally {
      await h.close();
    }
  });

  it('rejects a foreign Host header with 421 (DNS rebinding)', async () => {
    const h = await createCollectorHarness();
    try {
      expect(await rawGet(h.url + '/health', { host: 'attacker.test' })).toBe(421);
    } finally {
      await h.close();
    }
  });

  it('answers 405 for the wrong method on a route', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      expect((await fetch(h.url + '/api/entries', { method: 'POST', headers: { cookie } })).status).toBe(405);
      expect((await fetch(h.url + '/api/clear', { headers: { cookie } })).status).toBe(405);
      expect((await fetch(h.url + '/api/pause', { headers: { cookie } })).status).toBe(405);
    } finally {
      await h.close();
    }
  });

  it('rejects a loopback Origin on a different port with 403', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const realPort = Number(new URL(h.url).port);
      const otherOrigin = `http://127.0.0.1:${realPort === 65535 ? realPort - 1 : realPort + 1}`;
      expect((await fetch(h.url + '/api/clear', {
        method: 'POST', headers: { cookie, origin: otherOrigin },
      })).status).toBe(403);
      // Data untouched: the port-mismatched Origin never reached the mutation.
      expect(h.store.entries('d1')).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('accepts an admin bearer without Origin for CLI on loopback', async () => {
    const h = await createCollectorHarness();
    try {
      const res = await fetch(h.url + '/api/entries', { headers: { authorization: `Bearer ${h.adminToken}` } });
      expect(res.status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('rejects a revoked session and closes its /ui socket (logout)', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const ws = new WebSocket(h.url.replace('http', 'ws') + '/ui', { headers: { cookie, origin: h.origin } });
      await new Promise((r) => ws.on('open', r));
      const closed = new Promise<void>((r) => ws.on('close', () => r()));

      const out = await fetch(h.url + '/api/session', { method: 'DELETE', headers: { cookie, origin: h.origin } });
      expect(out.status).toBe(204);
      await closed; // logout terminated the live socket
      expect((await fetch(h.url + '/api/entries', { headers: { cookie } })).status).toBe(401);
    } finally {
      await h.close();
    }
  });
});

describe('/ui upgrades', () => {
  it('rejects /ui upgrade without a session (S1)', async () => {
    const h = await createCollectorHarness();
    try {
      expect((await upgrade(h.url, '/ui', { origin: h.origin })).ok).toBe(false);
    } finally { await h.close(); }
  });
  it('accepts /ui upgrade with a valid session cookie (S1)', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      expect((await upgrade(h.url, '/ui', { cookie, origin: h.origin })).ok).toBe(true);
    } finally { await h.close(); }
  });
  it('rejects /ui upgrade with a foreign Origin (B5)', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      expect((await upgrade(h.url, '/ui', { cookie, origin: 'http://evil.test' })).ok).toBe(false);
    } finally { await h.close(); }
  });
  it('rejects a /ingest upgrade on the loopback HTTP server (capture is TLS-only now)', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      // Device capture ingest moved to the TLS LAN listener; the loopback server
      // no longer speaks /ingest even for an authenticated session.
      expect((await upgrade(h.url, '/ingest', { cookie, origin: h.origin })).ok).toBe(false);
    } finally { await h.close(); }
  });
  it('removes all store listeners when a /ui socket closes (S3)', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const before = h.store.listenerCount('entry');
      const ws = new WebSocket(h.url.replace('http', 'ws') + '/ui', { headers: { cookie, origin: h.origin } });
      await new Promise((r) => ws.on('open', r));
      await new Promise((r) => setTimeout(r, 30));
      expect(h.store.listenerCount('entry')).toBe(before + 1);
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(h.store.listenerCount('entry')).toBe(before);
      expect(h.store.listenerCount('wsframe')).toBe(before);
    } finally { await h.close(); }
  });
});

describe('streaming exports (R5)', () => {
  it('streams a HAR download with nosniff and attachment headers', async () => {
    const h = await createCollectorHarness();
    try {
      seed(h.store);
      const cookie = await h.login();
      const res = await fetch(h.url + '/export.har?device=d1', { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="terminus-\d+\.har"/);
      const har = await res.json();
      expect(har.log.version).toBe('1.2');
      expect(har.log.entries).toHaveLength(1);
    } finally { await h.close(); }
  });

  it('streams a JSON download with { entries, ws } from the snapshot', async () => {
    const h = await createCollectorHarness();
    try {
      seed(h.store);
      const cookie = await h.login();
      const res = await fetch(h.url + '/export.json?device=d1', { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const doc = await res.json();
      expect(Array.isArray(doc.entries)).toBe(true);
      expect(Array.isArray(doc.ws)).toBe(true);
      expect(doc.entries).toHaveLength(1);
    } finally { await h.close(); }
  });
});

describe('/health version (T1.3)', () => {
  it('reports the collector package.json version', async () => {
    const h = await createCollectorHarness();
    try {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
      const body = await (await fetch(h.url + '/health')).json();
      expect(body.version).toBe(pkg.version);
    } finally { await h.close(); }
  });
});

describe('GET /api/status (T1.4)', () => {
  it('requires auth and returns the operational-status shape', async () => {
    const h = await createCollectorHarness();
    try {
      seed(h.store);
      // Same session-or-bearer gate as every other /api/* route.
      expect((await fetch(h.url + '/api/status')).status).toBe(401);

      const cookie = await h.login();
      const res = await fetch(h.url + '/api/status', { headers: { cookie } });
      expect(res.status).toBe(200);
      const b = await res.json();
      expect(typeof b.version).toBe('string');
      expect(typeof b.uptimeMs).toBe('number');
      expect(b.paused).toBe(false);
      expect(typeof b.devices).toBe('number');
      expect(typeof b.retention.evictedForBodyBudget).toBe('number');
      expect(b.bodies).toMatchObject({
        retainedBytes: expect.any(Number), blobCount: expect.any(Number), references: expect.any(Number),
      });
      expect(b.ingest).toMatchObject({
        connections: expect.any(Number), queued: expect.any(Number), rejectedDeviceAuth: expect.any(Number),
      });

      // Version is the single source of truth shared with /health.
      const health = await (await fetch(h.url + '/health')).json();
      expect(b.version).toBe(health.version);
    } finally { await h.close(); }
  });

  it('answers 405 for a non-GET', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      expect((await fetch(h.url + '/api/status', { method: 'POST', headers: { cookie } })).status).toBe(405);
    } finally { await h.close(); }
  });
});

describe('safeStaticPath', () => {
  it('rejects static paths escaping uiDir, incl. sibling prefix (S4)', () => {
    const uiDir = path.resolve('/app/dist-ui');
    expect(safeStaticPath(uiDir, '/index.html')).toBe(path.join(uiDir, 'index.html'));
    expect(safeStaticPath(uiDir, '/')).toBe(path.join(uiDir, 'index.html'));
    expect(safeStaticPath(uiDir, '/../dist-ui-evil/x')).toBeNull();
    expect(safeStaticPath(uiDir, '/../../etc/passwd')).toBeNull();
  });
});

// T8.2: one Origin gate (`requireMutation`) guards every state-changing route. The
// rule: a cookie/session caller must present an exact loopback Origin; a bearer CLI
// caller need not. `DELETE /api/session` is the exception — it is cookie-only, so it
// always requires an Origin, even for a bearer with no cookie. A malformed Origin is
// already rejected globally (`403 bad origin`) before the route runs.
describe('unified mutation Origin gate (T8.2)', () => {
  // A replay entry pointing at a refused port: replay fails fast (network error) but
  // still stores a 201, so a passed gate is observable without a live target.
  function seedReplay(store: import('../src/store.js').Store): void {
    store.addEntry({
      id: 'gate-r', deviceId: 'd1', source: 'xhr', startedAt: 1, method: 'GET', url: 'http://127.0.0.1:1/',
      requestHeaders: {}, requestBody: null, requestBodySize: 0, requestBodyOmitted: null,
      status: 200, statusText: 'OK', responseHeaders: {}, responseBody: null, responseBodySize: 0,
      responseBodyOmitted: null, durationMs: 1, error: null,
    });
  }

  type Cell = { name: string; auth: 'bearer' | 'cookie'; origin: 'none' | 'valid' | 'invalid'; expect: number };
  // clear/pause/replay share the cookie-needs-Origin rule; a bearer is exempt.
  const dataCells = (ok: number): Cell[] => [
    { name: 'bearer, no Origin', auth: 'bearer', origin: 'none', expect: ok },
    { name: 'cookie, valid Origin', auth: 'cookie', origin: 'valid', expect: ok },
    { name: 'cookie, no Origin', auth: 'cookie', origin: 'none', expect: 403 },
    { name: 'cookie, wrong Origin', auth: 'cookie', origin: 'invalid', expect: 403 },
  ];

  const routes: { path: string; method: string; ok: number; body?: string; cells: Cell[] }[] = [
    { path: '/api/clear', method: 'POST', ok: 200, cells: dataCells(200) },
    { path: '/api/pause', method: 'POST', ok: 200, body: JSON.stringify({ paused: false }), cells: dataCells(200) },
    { path: '/api/replay', method: 'POST', ok: 201, body: JSON.stringify({ deviceId: 'd1', id: 'gate-r' }), cells: dataCells(201) },
    // DELETE /api/session is cookie-only: an Origin is always required, so even a
    // bearer-without-Origin caller is refused. Only cookie+valid Origin succeeds (204).
    {
      path: '/api/session', method: 'DELETE', ok: 204, cells: [
        { name: 'bearer, no Origin', auth: 'bearer', origin: 'none', expect: 403 },
        { name: 'cookie, valid Origin', auth: 'cookie', origin: 'valid', expect: 204 },
        { name: 'cookie, no Origin', auth: 'cookie', origin: 'none', expect: 403 },
        { name: 'cookie, wrong Origin', auth: 'cookie', origin: 'invalid', expect: 403 },
      ],
    },
  ];

  for (const route of routes) {
    for (const cell of route.cells) {
      it(`${route.method} ${route.path} — ${cell.name} → ${cell.expect}`, async () => {
        const h = await createCollectorHarness();
        try {
          seed(h.store); seedReplay(h.store);
          const cookie = cell.auth === 'cookie' ? await h.login() : null;
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (cell.auth === 'bearer') headers.authorization = `Bearer ${h.adminToken}`;
          if (cookie) headers.cookie = cookie;
          if (cell.origin === 'valid') headers.origin = h.origin;
          if (cell.origin === 'invalid') headers.origin = 'http://evil.test';
          const res = await fetch(h.url + route.path, { method: route.method, headers, body: route.body });
          expect(res.status).toBe(cell.expect);
        } finally { await h.close(); }
      });
    }
  }
});
