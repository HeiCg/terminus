import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createCollectorHarness, type CollectorHarness } from '../../collector/test/fixtures/harness.js';
import type { Entry } from '../../collector/src/types.js';
import { runCli } from './helpers.js';

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

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'r1', deviceId: 'd1', source: 'xhr', startedAt: Date.now(),
    method: 'POST', url: `${targetUrl}/v1/items`,
    requestHeaders: { 'content-type': 'application/json' }, requestBody: '{"a":1}', requestBodySize: 7, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":true}', responseBodySize: 11, responseBodyOmitted: null,
    durationMs: 42, error: null, ...over,
  };
}

describe('terminus replay (T7.2)', () => {
  let h: CollectorHarness;
  beforeAll(async () => { h = await createCollectorHarness(); });
  afterAll(async () => { await h.close(); });

  it('re-sends the request and prints the status and new key', async () => {
    h.store.addEntry(entry({ id: 'a1' }));
    const before = seen.length;
    const r = await runCli(['replay', 'd1/a1'], { harness: h });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('replayed d1/a1 -> 200');
    expect(r.stdout).toMatch(/stored as d1\/replay-/);
    expect(seen[before].method).toBe('POST');
    expect(seen[before].body).toBe('{"a":1}');
    const rep = h.store.entries('d1').find((e) => e.source === 'replay');
    expect(rep?.replayOf).toEqual({ id: 'a1', credentials: 'strip', stripped: [] });
  });

  it('applies --method, --url, repeatable --header and --body', async () => {
    h.store.addEntry(entry({ id: 'a2' }));
    const before = seen.length;
    const r = await runCli(
      ['replay', 'd1/a2', '--method', 'PUT', '--url', `${targetUrl}/other`, '--header', 'x-one: 1', '--header', 'x-two: 2', '--body', 'HELLO'],
      { harness: h },
    );
    expect(r.code).toBe(0);
    const hit = seen[before];
    expect(hit.method).toBe('PUT');
    expect(hit.url).toBe('/other');
    expect(hit.body).toBe('HELLO');
    expect(hit.headers['x-one']).toBe('1');
    expect(hit.headers['x-two']).toBe('2');
  });

  it('reads the override body from --body-file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'replay-'));
    try {
      const f = path.join(dir, 'body.json');
      await writeFile(f, '{"from":"file"}');
      h.store.addEntry(entry({ id: 'a3' }));
      const before = seen.length;
      const r = await runCli(['replay', 'd1/a3', '--body-file', f], { harness: h });
      expect(r.code).toBe(0);
      expect(seen[before].body).toBe('{"from":"file"}');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('--body-file sends the file bytes verbatim (bodyBase64), binary included (U4)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'replay-'));
    try {
      const f = path.join(dir, 'body.bin');
      const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0x41, 0x00]);
      await writeFile(f, bytes);
      h.store.addEntry(entry({ id: 'a5' }));
      const before = seen.length;
      const r = await runCli(['replay', 'd1/a5', '--body-file', f], { harness: h });
      expect(r.code).toBe(0);
      expect(Buffer.compare(seen[before].raw, bytes)).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('--body and --body-file together are refused', async () => {
    const r = await runCli(['replay', 'd1/a1', '--body', 'x', '--body-file', '/nonexistent'], { harness: h });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('pass only one of --body / --body-file');
  });

  it('--json prints the endpoint response', async () => {
    h.store.addEntry(entry({ id: 'a4' }));
    const r = await runCli(['replay', 'd1/a4', '--json'], { harness: h });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { key: { id: string }; status: number };
    expect(parsed.status).toBe(200);
    expect(parsed.key.id.startsWith('replay-')).toBe(true);
  });

  it('strips captured credentials by default and lists them (T8.1)', async () => {
    h.store.addEntry(entry({
      id: 'c1',
      requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer secret', cookie: 'sid=1' },
    }));
    const before = seen.length;
    const r = await runCli(['replay', 'd1/c1'], { harness: h });
    expect(r.code).toBe(0);
    expect(seen[before].headers.authorization).toBeUndefined();
    expect(seen[before].headers.cookie).toBeUndefined();
    expect(r.stdout).toContain('stripped: authorization, cookie');
  });

  it('--with-credentials re-sends the captured credentials (T8.1)', async () => {
    h.store.addEntry(entry({
      id: 'c2',
      requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer secret', cookie: 'sid=1' },
    }));
    const before = seen.length;
    const r = await runCli(['replay', 'd1/c2', '--with-credentials'], { harness: h });
    expect(r.code).toBe(0);
    expect(seen[before].headers.authorization).toBe('Bearer secret');
    expect(seen[before].headers.cookie).toBe('sid=1');
    expect(r.stdout).not.toContain('stripped:');
  });

  it('exit 1 with a helpful message on an unknown entry (404)', async () => {
    const r = await runCli(['replay', 'd1/ghost'], { harness: h });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('/api/replay');
  });

  it('rejects a missing target argument', async () => {
    const r = await runCli(['replay'], { harness: h });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('usage: terminus replay');
  });
});

describe('terminus replay --body-file against an older collector (U4)', () => {
  it('refuses before replaying when the collector lacks replay-bytes', async () => {
    const hits: string[] = [];
    const fake = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '0.2.0', apiVersion: 1, capabilities: ['seq'] }));
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    const port = (fake.address() as net.AddressInfo).port;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'replay-'));
    try {
      const f = path.join(dir, 'b.bin');
      await writeFile(f, Buffer.from([1, 2, 3]));
      const r = await runCli(['replay', 'd1/x', '--body-file', f], { env: { TERMINUS_HOST: '127.0.0.1', TERMINUS_PORT: String(port), TERMINUS_TOKEN: 't' } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('replay-bytes');
      expect(hits).not.toContain('POST /api/replay');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await new Promise<void>((r) => fake.close(() => r()));
    }
  });
});
