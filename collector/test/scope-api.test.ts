import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { loadScopeFile } from '../src/scope.js';
import { createCollectorHarness } from './fixtures/harness.js';
import type { Entry } from '../src/types.js';

// U5: the capture scope over HTTP. `GET /api/status` reports it; `GET/PUT
// /api/scope` read and replace it (admin only), persisted to the state dir.

const entry = (id: string, url: string): Entry => ({
  id, deviceId: 'd1', source: 'xhr', startedAt: 1, method: 'GET', url,
  requestHeaders: {}, requestBody: null, requestBodySize: 0, requestBodyOmitted: null,
  status: 200, statusText: 'OK', responseHeaders: {}, responseBody: null, responseBodySize: 0, responseBodyOmitted: null, durationMs: 1, error: null,
});

describe('/api/status scope and /api/scope', () => {
  it('reports the scope and its per-reason drop counters on /api/status', async () => {
    const h = await createCollectorHarness({ store: new Store({ scope: { include: ['*.app.test'], exclude: ['cdn.app.test'] } }) });
    try {
      h.store.addEntry(entry('a', 'https://api.app.test/x'));
      h.store.addEntry(entry('b', 'https://cdn.app.test/img'));
      h.store.addEntry(entry('c', 'https://tracker.example/p'));
      const st = await (await fetch(h.url + '/api/status', { headers: { authorization: `Bearer ${h.readerToken}` } })).json();
      expect(st.scope).toEqual({ include: ['*.app.test'], exclude: ['cdn.app.test'], dropped: { excluded: 1, notIncluded: 1 } });
      expect(st.capabilities).toEqual(expect.arrayContaining(['scope', 'tls-passthrough', 'raw-streams']));
    } finally { await h.close(); }
  });

  it('is admin only: reader 403 forbidden_scope, no credential 401', async () => {
    const h = await createCollectorHarness();
    try {
      const reader = await fetch(h.url + '/api/scope', { headers: { authorization: `Bearer ${h.readerToken}` } });
      expect(reader.status).toBe(403);
      expect(await reader.json()).toEqual({ error: 'forbidden_scope', required: 'admin' });
      const readerPut = await fetch(h.url + '/api/scope', { method: 'PUT', headers: { authorization: `Bearer ${h.readerToken}`, 'content-type': 'application/json' }, body: '{"include":["x.test"]}' });
      expect(readerPut.status).toBe(403);
      expect(h.store.scopeStatus().include).toEqual([]);
      expect((await fetch(h.url + '/api/scope')).status).toBe(401);
      expect((await fetch(h.url + '/api/scope', { method: 'PUT', body: '{}' })).status).toBe(401);
    } finally { await h.close(); }
  });

  it('PUT validates the whole body and replaces both lists', async () => {
    const h = await createCollectorHarness();
    const put = (body: string, headers: Record<string, string> = {}) => fetch(h.url + '/api/scope', { method: 'PUT', headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json', ...headers }, body });
    try {
      for (const bad of ['not json', '[]', '{"include":"a.com"}', '{"include":["a.com","b.com:8080"]}', '{"exclude":["*"]}', '{"other":[]}']) {
        const r = await put(bad);
        expect(r.status, bad).toBe(400);
        expect((await r.json()).error).toBe('bad_request');
      }
      expect((await put(JSON.stringify({ include: ['x'.repeat(70_000)] }))).status).toBe(413);
      expect(h.store.scopeStatus()).toMatchObject({ include: [], exclude: [] });

      const ok = await put('{"include":["*.app.test","api.other.test/v1/*"],"exclude":["cdn.app.test"]}');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ include: ['*.app.test', 'api.other.test/v1/*'], exclude: ['cdn.app.test'], dropped: { excluded: 0, notIncluded: 0 } });
      // Replace, not merge: an omitted list becomes empty.
      await put('{"exclude":["ads.test"]}');
      const got = await (await fetch(h.url + '/api/scope', { headers: { authorization: `Bearer ${h.adminToken}` } })).json();
      expect(got).toMatchObject({ include: [], exclude: ['ads.test'] });
      // Applies to new records immediately.
      h.store.addEntry(entry('a', 'https://ads.test/p'));
      h.store.addEntry(entry('b', 'https://ok.test/p'));
      expect(h.store.entries().map((e) => e.id)).toEqual(['b']);
    } finally { await h.close(); }
  });

  it('a cookie PUT needs the exact Origin', async () => {
    const h = await createCollectorHarness();
    try {
      const cookie = await h.login();
      const noOrigin = await fetch(h.url + '/api/scope', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: '{"include":["a.test"]}' });
      expect(noOrigin.status).toBe(403);
      const withOrigin = await fetch(h.url + '/api/scope', { method: 'PUT', headers: { cookie, origin: h.origin, 'content-type': 'application/json' }, body: '{"include":["a.test"]}' });
      expect(withOrigin.status).toBe(200);
    } finally { await h.close(); }
  });

  it('persists to <stateDir>/scope.json (0600) and survives a store/collector restart', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-scope-state-'));
    const scopeFile = path.join(stateDir, 'scope.json');
    try {
      const first = await createCollectorHarness({ scopeFile });
      try {
        const r = await fetch(first.url + '/api/scope', { method: 'PUT', headers: { authorization: `Bearer ${first.adminToken}`, 'content-type': 'application/json' }, body: '{"include":["api.app.test"],"exclude":[]}' });
        expect(r.status).toBe(200);
      } finally { await first.close(); }
      expect(fs.statSync(scopeFile).mode & 0o777).toBe(0o600);

      // Restart: a new Store seeded the way main.ts does (file first, env otherwise).
      const restored = loadScopeFile(scopeFile);
      expect(restored).toEqual({ include: ['api.app.test'], exclude: [] });
      const second = await createCollectorHarness({ scopeFile, store: new Store({ scope: restored ?? undefined }) });
      try {
        const got = await (await fetch(second.url + '/api/scope', { headers: { authorization: `Bearer ${second.adminToken}` } })).json();
        expect(got).toEqual({ include: ['api.app.test'], exclude: [], dropped: { excluded: 0, notIncluded: 0 } });
        second.store.addEntry(entry('x', 'https://elsewhere.test/'));
        expect(second.store.entries()).toHaveLength(0);
      } finally { await second.close(); }
    } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
  });
});
