import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { writeTokenFile } from '../../collector/src/security/adminToken.js';
import { createCollectorHarness, type CollectorHarness } from '../../collector/test/fixtures/harness.js';
import { TerminusApi } from '../src/api.js';
import { tempStateDir, settingsFor, connect, call, text, toolNames, makeEntry } from './helpers.js';

// terminus_replay is exposed only with the admin token AND TERMINUS_MCP_ALLOW_REPLAY=1,
// and then sends exactly what the CLI's `terminus replay` sends.

let target: http.Server;
let targetUrl = '';
const seen: { method: string; url: string; body: string; raw: Buffer; headers: http.IncomingHttpHeaders }[] = [];

beforeAll(async () => {
  target = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: raw.toString('utf8'), raw, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  targetUrl = `http://127.0.0.1:${(target.address() as net.AddressInfo).port}`;
});
afterAll(() => { target.close(); });

let dir: string;
let h: CollectorHarness;
beforeEach(async () => {
  dir = tempStateDir();
  h = await createCollectorHarness();
  writeTokenFile('admin-token', h.adminToken, dir);
  writeTokenFile('reader-token', h.readerToken, dir);
});
afterEach(async () => { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const OPT_IN = { TERMINUS_MCP_ALLOW_REPLAY: '1' };

describe('terminus_replay registration', () => {
  it('is absent with the reader token, even with the opt-in', async () => {
    const c = await connect(settingsFor(h, { token: null, env: OPT_IN, stateDir: dir })); // reader-token file wins
    try { expect(await toolNames(c)).not.toContain('terminus_replay'); } finally { await c.close(); }
  });

  it('is absent with the admin token but without the opt-in', async () => {
    const c = await connect(settingsFor(h, { token: h.adminToken, stateDir: dir }));
    try { expect(await toolNames(c)).not.toContain('terminus_replay'); } finally { await c.close(); }
  });

  it('is present with the admin token and the opt-in (token from env or from the admin-token file)', async () => {
    const viaEnv = await connect(settingsFor(h, { token: h.adminToken, env: OPT_IN, stateDir: dir }));
    try { expect(await toolNames(viaEnv)).toContain('terminus_replay'); } finally { await viaEnv.close(); }
    fs.rmSync(`${dir}/reader-token`);
    const viaFile = await connect(settingsFor(h, { token: null, env: OPT_IN, stateDir: dir }));
    try { expect(await toolNames(viaFile)).toContain('terminus_replay'); } finally { await viaFile.close(); }
  });
});

describe('terminus_replay', () => {
  it('replays with credentials stripped by default and returns the new entry line', async () => {
    h.store.addEntry(makeEntry({ id: 'a1', url: `${targetUrl}/v1/items`, requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer secret', cookie: 'sid=1' } }));
    const c = await connect(settingsFor(h, { token: h.adminToken, env: OPT_IN, stateDir: dir }));
    try {
      const before = seen.length;
      const r = await call(c, 'terminus_replay', { deviceId: 'd1', id: 'a1' });
      expect(r.isError).toBeFalsy();
      const t = text(r);
      expect(t).toMatch(/^replayed -> 200 in \d+ms/);
      expect(t).toContain('stripped credentials: authorization, cookie');
      expect(t).toMatch(/#2 POST 127\.0\.0\.1:\d+\/v1\/items 200 \d+ms req 7B res 11B src=replay \[device=d1 id=replay-[0-9a-f]+\]/);
      expect(seen[before].headers.authorization).toBeUndefined();
      expect(seen[before].headers.cookie).toBeUndefined();
      expect(seen[before].body).toBe('{"a":1}');
      expect(h.store.entries('d1').find((e) => e.source === 'replay')?.replayOf).toEqual({ id: 'a1', credentials: 'strip', stripped: ['authorization', 'cookie'] });
    } finally { await c.close(); }
  });

  it('applies overrides and withCredentials', async () => {
    h.store.addEntry(makeEntry({ id: 'a2', url: `${targetUrl}/v1/items`, requestHeaders: { authorization: 'Bearer secret' } }));
    const c = await connect(settingsFor(h, { token: h.adminToken, env: OPT_IN, stateDir: dir }));
    try {
      const before = seen.length;
      const r = await call(c, 'terminus_replay', {
        deviceId: 'd1', id: 'a2', withCredentials: true,
        overrides: { method: 'PUT', url: `${targetUrl}/other`, body: 'HELLO' },
      });
      expect(r.isError).toBeFalsy();
      expect(seen[before]).toMatchObject({ method: 'PUT', url: '/other', body: 'HELLO' });
      expect(seen[before].headers.authorization).toBe('Bearer secret');
      expect(text(r)).not.toContain('stripped');
    } finally { await c.close(); }
  });

  it('overrides.bodyBase64 sends raw bytes (U4)', async () => {
    h.store.addEntry(makeEntry({ id: 'a3', url: `${targetUrl}/v1/bin` }));
    const c = await connect(settingsFor(h, { token: h.adminToken, env: OPT_IN, stateDir: dir }));
    try {
      const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80]);
      const before = seen.length;
      const r = await call(c, 'terminus_replay', { deviceId: 'd1', id: 'a3', overrides: { bodyBase64: bytes.toString('base64') } });
      expect(r.isError).toBeFalsy();
      expect(Buffer.compare(seen[before].raw, bytes)).toBe(0);
    } finally { await c.close(); }
  });

  it('body and bodyBase64 together are refused before anything is sent', async () => {
    h.store.addEntry(makeEntry({ id: 'a4', url: `${targetUrl}/v1/items` }));
    const c = await connect(settingsFor(h, { token: h.adminToken, env: OPT_IN, stateDir: dir }));
    try {
      const before = seen.length;
      const r = await call(c, 'terminus_replay', { deviceId: 'd1', id: 'a4', overrides: { body: 'x', bodyBase64: 'eA==' } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('only one of overrides.body and overrides.bodyBase64');
      expect(seen.length).toBe(before);
    } finally { await c.close(); }
  });

  it('an unknown entry is a tool error', async () => {
    const c = await connect(settingsFor(h, { token: h.adminToken, env: OPT_IN, stateDir: dir }));
    try {
      const r = await call(c, 'terminus_replay', { deviceId: 'd1', id: 'ghost' });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('not found (404)');
    } finally { await c.close(); }
  });

  it('the real collector answers a reader-token replay with the mapped 403 message', async () => {
    const api = new TerminusApi(settingsFor(h, { stateDir: dir }).conn, () => h.readerToken);
    await expect(api.postJson('/api/replay', { deviceId: 'd1', id: 'x' })).rejects.toThrow('forbidden (403 forbidden_scope): POST /api/replay needs the admin token');
  });
});
