import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { Entry } from '../src/types.js';
import type { PairingImport } from '../src/security/types.js';
import { readerAllowed } from '../src/http.js';
import { createCollectorHarness, type CollectorHarness } from './fixtures/harness.js';
import { RulesStore } from '../src/rulesStore.js';

// P3: the reader token's scope, as a route × credential matrix. Every route the
// HTTP server serves has a row here (the coverage test at the bottom parses
// http.ts and fails when a route literal has no row), so a new route cannot ship
// without someone deciding what a reader gets from it.

type Cred = 'admin' | 'reader' | 'cookie' | 'none';
// An HTTP status, or for the /ui upgrade: 'open' (socket accepted) / 'dropped'
// (socket destroyed without a response, the pre-P3 behaviour for a bad credential).
type Outcome = number | 'open' | 'dropped';
type Row = { method: string; path: string; body?: string; expect: Record<Cred, Outcome> };

const ok200 = { admin: 200, reader: 200, cookie: 200, none: 401 } as const;
const adminOnly = (admin: Outcome, cookie: Outcome = admin): Record<Cred, Outcome> => ({ admin, reader: 403, cookie, none: 401 });

const MATRIX: Row[] = [
  { method: 'GET', path: '/health', expect: { admin: 200, reader: 200, cookie: 200, none: 200 } },
  { method: 'GET', path: '/', expect: { admin: 200, reader: 200, cookie: 200, none: 200 } }, // static shell, never gated
  { method: 'POST', path: '/api/session', expect: { admin: 204, reader: 403, cookie: 401, none: 401 } },
  { method: 'DELETE', path: '/api/session', expect: { admin: 204, reader: 403, cookie: 204, none: 204 } },
  { method: 'GET', path: '/api/pairing', expect: adminOnly(200) },
  // P2 host override: still admin-only; a host outside the SAN is the admin's 400.
  { method: 'GET', path: '/api/pairing?host=bogus.example', expect: adminOnly(400) },
  { method: 'GET', path: '/api/status', expect: ok200 },
  { method: 'GET', path: '/api/devices', expect: ok200 },
  { method: 'GET', path: '/api/devices?bundleId=b&externalId=x', expect: ok200 },
  { method: 'GET', path: '/api/entries', expect: ok200 },
  { method: 'GET', path: '/api/entries?afterSeq=0', expect: ok200 },
  { method: 'GET', path: '/api/entries?last=5', expect: ok200 },
  // P2 device-scope filters are plain query variants of the same reader route.
  { method: 'GET', path: '/api/entries?afterSeq=0&externalId=x&device=d1', expect: ok200 },
  { method: 'GET', path: '/api/entries?last=5&bundleId=b', expect: ok200 },
  { method: 'GET', path: '/api/entries?bundleId=b', expect: ok200 },
  { method: 'GET', path: '/api/entries/d1/seed-1', expect: ok200 },
  { method: 'GET', path: '/api/entries/d1/seed-1/body', expect: ok200 },
  { method: 'GET', path: '/api/entries/d1/seed-1/body?side=request', expect: ok200 },
  // The P4 long-poll is a reader route too (the seeded entry answers it at once).
  { method: 'GET', path: '/api/entries/wait?afterSeq=0', expect: ok200 },
  { method: 'POST', path: '/api/entries', expect: adminOnly(405) },
  { method: 'GET', path: '/api/ws', expect: ok200 },
  { method: 'GET', path: '/api/ws/d1/w1/frames', expect: ok200 },
  { method: 'GET', path: '/api/ws/d1/w1/frames/0/body', expect: ok200 },
  { method: 'POST', path: '/api/clear', expect: adminOnly(200) },
  { method: 'POST', path: '/api/pause', body: '{"paused":true}', expect: adminOnly(200) },
  { method: 'POST', path: '/api/replay', body: '{"deviceId":"d1","id":"missing"}', expect: adminOnly(404) },
  // U5 capture scope: admin only, never in the reader allowlist.
  { method: 'GET', path: '/api/scope', expect: adminOnly(200) },
  { method: 'PUT', path: '/api/scope', body: '{"include":[],"exclude":["ads.example"]}', expect: adminOnly(200) },
  { method: 'PUT', path: '/api/scope?bad', body: '{"include":["https://x"]}', expect: adminOnly(400) },
  { method: 'POST', path: '/api/scope', expect: adminOnly(405) },
  // U6 interception rules: admin only, never in the reader allowlist.
  { method: 'GET', path: '/api/rules', expect: adminOnly(200) },
  { method: 'PUT', path: '/api/rules', body: '{"rules":[{"id":"r2","name":"slow","phase":"request","action":{"type":"delay","ms":5}}]}', expect: adminOnly(200) },
  { method: 'PUT', path: '/api/rules?bad', body: '{"rules":[{"id":"r2","name":"x","phase":"request","action":{"type":"delay","ms":0}}]}', expect: adminOnly(400) },
  { method: 'POST', path: '/api/rules', expect: adminOnly(405) },
  { method: 'PATCH', path: '/api/rules/seed-rule', body: '{"enabled":false}', expect: adminOnly(200) },
  { method: 'PATCH', path: '/api/rules/missing', body: '{"enabled":false}', expect: adminOnly(404) },
  { method: 'GET', path: '/api/rules/seed-rule', expect: adminOnly(405) },
  { method: 'GET', path: '/export.har', expect: adminOnly(200) },
  { method: 'GET', path: '/export.json', expect: adminOnly(200) },
  // Unlisted path: admin-only by default, so a reader never even learns it is a 404.
  { method: 'GET', path: '/api/not-a-route', expect: adminOnly(404) },
  { method: 'UPGRADE', path: '/ui', expect: { admin: 'open', reader: 403, cookie: 'open', none: 'dropped' } },
];

const FAKE_PAIRING = { host: '127.0.0.1', deviceToken: 'device-secret' } as unknown as PairingImport;

let uiDir: string;
beforeAll(() => {
  uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-reader-ui-'));
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html>');
});
afterAll(() => { fs.rmSync(uiDir, { recursive: true, force: true }); });

function seed(h: CollectorHarness): void {
  const e: Entry = {
    id: 'seed-1', deviceId: 'd1', source: 'xhr', startedAt: 1, method: 'POST', url: 'https://x/y',
    requestHeaders: {}, requestBody: 'req-body', requestBodySize: 8, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: {}, responseBody: 'res-body', responseBodySize: 8,
    responseBodyOmitted: null, durationMs: 1, error: null,
  };
  h.store.addEntry(e);
  h.store.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'atlantis', url: 'wss://x', openedAt: 1 });
  h.store.appendWsFrame('w1', { ts: 2, direction: 'in', data: 'frame', size: 5, binary: false }, null, 'd1');
}

async function headersFor(h: CollectorHarness, cred: Cred): Promise<Record<string, string>> {
  const base = { origin: h.origin };
  if (cred === 'admin') return { ...base, authorization: `Bearer ${h.adminToken}` };
  if (cred === 'reader') return { ...base, authorization: `Bearer ${h.readerToken}` };
  if (cred === 'cookie') return { ...base, cookie: await h.login() };
  return base;
}

function upgrade(h: CollectorHarness, headers: Record<string, string>): Promise<{ outcome: Outcome; body: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(h.url.replace('http', 'ws') + '/ui', { headers });
    ws.on('open', () => { resolve({ outcome: 'open', body: '' }); ws.close(); });
    ws.on('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => { resolve({ outcome: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }); ws.terminate(); });
    });
    ws.on('error', () => resolve({ outcome: 'dropped', body: '' }));
  });
}

async function call(h: CollectorHarness, row: Row, cred: Cred): Promise<{ outcome: Outcome; body: string }> {
  const headers = await headersFor(h, cred);
  if (row.method === 'UPGRADE') return upgrade(h, headers);
  if (row.body) headers['content-type'] = 'application/json';
  const res = await fetch(h.url + row.path, { method: row.method, headers, body: row.body });
  return { outcome: res.status, body: await res.text() };
}

const CREDS: Cred[] = ['admin', 'reader', 'cookie', 'none'];

describe('reader scope matrix (P3): route × {admin bearer, reader bearer, cookie, none}', () => {
  for (const row of MATRIX) {
    for (const cred of CREDS) {
      it(`${row.method} ${row.path} as ${cred} -> ${row.expect[cred]}`, async () => {
        const rules = new RulesStore([{ id: 'seed-rule', name: 'seed', enabled: true, match: {}, phase: 'request', action: { type: 'delay', ms: 1 } }]);
        const h = await createCollectorHarness({ uiDir, getPairing: () => FAKE_PAIRING, rules });
        try {
          seed(h);
          const r = await call(h, row, cred);
          expect(r.outcome).toBe(row.expect[cred]);
          if (cred === 'reader' && r.outcome === 403) {
            expect(JSON.parse(r.body)).toEqual({ error: 'forbidden_scope', required: 'admin' });
          }
          // A refused reader mutation never touched state.
          if (cred === 'reader' && row.method !== 'GET') {
            expect(h.store.entries('d1')).toHaveLength(1);
            expect(h.rules.list()).toEqual([expect.objectContaining({ id: 'seed-rule', enabled: true })]);
          }
        } finally { await h.close(); }
      });
    }
  }

  it('every route literal in http.ts has a matrix row', () => {
    const src = readFileSync(new URL('../src/http.ts', import.meta.url), 'utf8');
    const routes = new Set<string>();
    for (const m of src.matchAll(/u\.pathname === '([^']+)'/g)) routes.add(m[1]);
    for (const m of src.matchAll(/seg\[1\] === '([^']+)'/g)) routes.add(`/api/${m[1]}`);
    for (const m of src.matchAll(/p !== '([^']+)'/g)) routes.add(m[1]);
    expect(routes.size).toBeGreaterThan(10); // the parse itself still works
    const covered = new Set(MATRIX.map((r) => new URL(r.path, 'http://x').pathname));
    const missing = [...routes].filter((r) => !covered.has(r));
    expect(missing).toEqual([]);
  });
});

describe('reader token behaviour (P3)', () => {
  it('reads an entry body and uses ?afterSeq= and ?last=', async () => {
    const h = await createCollectorHarness();
    try {
      seed(h);
      const auth = { authorization: `Bearer ${h.readerToken}` };
      const body = await fetch(`${h.url}/api/entries/d1/seed-1/body?side=response`, { headers: auth });
      expect(body.status).toBe(200);
      expect(await body.text()).toBe('res-body');
      const after = await (await fetch(`${h.url}/api/entries?afterSeq=0`, { headers: auth })).json();
      expect(after.items.map((i: { id: string }) => i.id)).toEqual(['seed-1']);
      const last = await (await fetch(`${h.url}/api/entries?last=1`, { headers: auth })).json();
      expect(last.items.map((i: { id: string }) => i.id)).toEqual(['seed-1']);
    } finally { await h.close(); }
  });

  it('cannot create a cookie session: 403 forbidden_scope and no Set-Cookie', async () => {
    const h = await createCollectorHarness();
    try {
      const res = await fetch(h.url + '/api/session', { method: 'POST', headers: { authorization: `Bearer ${h.readerToken}`, origin: h.origin } });
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await res.json()).toEqual({ error: 'forbidden_scope', required: 'admin' });
    } finally { await h.close(); }
  });

  it('a wrong bearer stays a bare 401, exactly as before', async () => {
    const h = await createCollectorHarness();
    try {
      const res = await fetch(h.url + '/api/entries', { headers: { authorization: 'Bearer nope' } });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('');
    } finally { await h.close(); }
  });

  it('advertises the reader-token capability', async () => {
    const h = await createCollectorHarness();
    try {
      expect((await (await fetch(h.url + '/health')).json()).capabilities).toContain('reader-token');
    } finally { await h.close(); }
  });

  it('the allowlist is GET-only and exact on its prefixes', () => {
    expect(readerAllowed('GET', '/api/entries/d1/x/body')).toBe(true);
    expect(readerAllowed('GET', '/api/ws/d1/w1/frames')).toBe(true);
    expect(readerAllowed('HEAD', '/api/entries')).toBe(false);
    expect(readerAllowed('POST', '/api/entries')).toBe(false);
    expect(readerAllowed('GET', '/api/entriesX')).toBe(false);
    expect(readerAllowed('GET', '/api/wsx')).toBe(false);
    expect(readerAllowed('GET', '/api/pairing')).toBe(false);
    expect(readerAllowed('GET', '/ui')).toBe(false);
  });
});
