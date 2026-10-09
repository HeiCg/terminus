import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RulesStore, loadRulesFile } from '../src/rulesStore.js';
import { createCollectorHarness } from './fixtures/harness.js';

// U6: the interception rules over HTTP. GET/PUT /api/rules and PATCH
// /api/rules/:id are admin only, validated whole, persisted to <stateDir>/rules.json.

const RULE = { id: 'mock-login', name: 'Mock login', enabled: true, match: { methods: ['POST'], host: 'api.app.test', path: '/login' }, phase: 'request', action: { type: 'mock', status: 200, body: '{"token":"x"}' } };

describe('/api/rules', () => {
  it('is admin only: reader 403 forbidden_scope, no credential 401, and advertised as a capability', async () => {
    const h = await createCollectorHarness();
    try {
      const reader = { authorization: `Bearer ${h.readerToken}`, 'content-type': 'application/json' };
      const r = await fetch(h.url + '/api/rules', { headers: reader });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'forbidden_scope', required: 'admin' });
      expect((await fetch(h.url + '/api/rules', { method: 'PUT', headers: reader, body: JSON.stringify({ rules: [RULE] }) })).status).toBe(403);
      expect((await fetch(h.url + '/api/rules/mock-login', { method: 'PATCH', headers: reader, body: '{"enabled":false}' })).status).toBe(403);
      expect(h.rules.list()).toEqual([]);
      expect((await fetch(h.url + '/api/rules')).status).toBe(401);
      const health = await (await fetch(h.url + '/health')).json();
      expect(health.capabilities).toContain('rules');
    } finally { await h.close(); }
  });

  it('PUT validates the whole list (400 with the path of the error) and replaces it', async () => {
    const h = await createCollectorHarness();
    const put = (body: string) => fetch(h.url + '/api/rules', { method: 'PUT', headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' }, body });
    try {
      const bad = await put(JSON.stringify({ rules: [RULE, { ...RULE, id: 'two', action: { type: 'mock', status: 999 } }] }));
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: 'bad_request', message: 'rules[1].action.status: must be an integer from 200 to 599', path: 'rules[1].action.status' });
      expect((await put('not json')).status).toBe(400);
      expect(h.rules.list()).toEqual([]); // a refused PUT changes nothing

      const ok = await put(JSON.stringify({ rules: [RULE, { name: 'no id', phase: 'response', action: { type: 'delay', ms: 5 } }] }));
      expect(ok.status).toBe(200);
      const got = (await ok.json()).rules;
      expect(got).toHaveLength(2);
      expect(got[0]).toEqual({ ...RULE, match: { methods: ['POST'], host: 'api.app.test', path: '/login' } });
      expect(got[1].id).toMatch(/^[0-9a-f-]{36}$/); // assigned
      expect(h.rules.list()).toEqual(got);

      // Replace, not merge.
      expect((await (await put('{"rules":[]}')).json()).rules).toEqual([]);
      const list = await (await fetch(h.url + '/api/rules', { headers: { authorization: `Bearer ${h.adminToken}` } })).json();
      expect(list).toEqual({ rules: [] });
    } finally { await h.close(); }
  });

  it('PATCH /api/rules/:id toggles enabled; 404 unknown id; 400 bad body', async () => {
    const h = await createCollectorHarness({ rules: new RulesStore([RULE as never]) });
    const patch = (id: string, body: string) => fetch(h.url + `/api/rules/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' }, body });
    try {
      const r = await patch('mock-login', '{"enabled":false}');
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ id: 'mock-login', enabled: false });
      expect(h.rules.list()[0].enabled).toBe(false);
      expect((await patch('nope', '{"enabled":true}')).status).toBe(404);
      for (const b of ['{}', '{"enabled":"yes"}', '{"enabled":true,"name":"x"}', '[]', 'nope']) expect((await patch('mock-login', b)).status, b).toBe(400);
      expect(h.rules.list()[0].enabled).toBe(false);
    } finally { await h.close(); }
  });

  it('a cookie PUT/PATCH needs the exact Origin', async () => {
    const h = await createCollectorHarness({ rules: new RulesStore([RULE as never]) });
    try {
      const cookie = await h.login();
      const body = JSON.stringify({ rules: [] });
      expect((await fetch(h.url + '/api/rules', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body })).status).toBe(403);
      expect((await fetch(h.url + '/api/rules/mock-login', { method: 'PATCH', headers: { cookie }, body: '{"enabled":false}' })).status).toBe(403);
      expect(h.rules.list()).toHaveLength(1);
      expect((await fetch(h.url + '/api/rules/mock-login', { method: 'PATCH', headers: { cookie, origin: h.origin }, body: '{"enabled":false}' })).status).toBe(200);
      expect((await fetch(h.url + '/api/rules', { method: 'PUT', headers: { cookie, origin: h.origin, 'content-type': 'application/json' }, body })).status).toBe(200);
      expect(h.rules.list()).toEqual([]);
    } finally { await h.close(); }
  });

  it('persists to <stateDir>/rules.json (0600) and survives a restart', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-rules-state-'));
    const file = path.join(stateDir, 'rules.json');
    try {
      const first = await createCollectorHarness({ rules: new RulesStore(loadRulesFile(file), file) });
      try {
        const auth = { authorization: `Bearer ${first.adminToken}`, 'content-type': 'application/json' };
        expect((await fetch(first.url + '/api/rules', { method: 'PUT', headers: auth, body: JSON.stringify({ rules: [RULE] }) })).status).toBe(200);
        expect((await fetch(first.url + '/api/rules/mock-login', { method: 'PATCH', headers: auth, body: '{"enabled":false}' })).status).toBe(200);
      } finally { await first.close(); }
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(stateDir)).toEqual(['rules.json']); // no temp file left behind

      // Restart: a new store seeded from the file, the way main.ts boots.
      const second = await createCollectorHarness({ rules: new RulesStore(loadRulesFile(file), file) });
      try {
        const got = await (await fetch(second.url + '/api/rules', { headers: { authorization: `Bearer ${second.adminToken}` } })).json();
        expect(got.rules).toEqual([{ ...RULE, enabled: false }]);
      } finally { await second.close(); }

      // A corrupt file is ignored (no rules), not fatal.
      fs.writeFileSync(file, '{"rules":[{"id":"x"}]}');
      expect(loadRulesFile(file)).toEqual([]);
      fs.writeFileSync(file, 'garbage');
      expect(loadRulesFile(file)).toEqual([]);
    } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
  });

  it('a failed write leaves the active list unchanged (500)', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-rules-ro-'));
    // The "file" path is a directory: the rename fails.
    const file = path.join(stateDir, 'rules.json');
    fs.mkdirSync(file);
    const h = await createCollectorHarness({ rules: new RulesStore([], file) });
    try {
      const r = await fetch(h.url + '/api/rules', { method: 'PUT', headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ rules: [RULE] }) });
      expect(r.status).toBe(500);
      expect(h.rules.list()).toEqual([]);
    } finally { await h.close(); fs.rmSync(stateDir, { recursive: true, force: true }); }
  });
});
