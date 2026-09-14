import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { Store } from '../src/store.js';
import { performReplay } from '../src/replay.js';
import { createCollectorHarness, type CollectorHarness } from './fixtures/harness.js';
import type { Entry } from '../src/types.js';

// A local target the replay fetch actually hits: it echoes the method, url, a
// chosen request header and the request body back as JSON so a test can assert
// what the collector re-sent. `/boom` closes the socket to force a network error.
let target: http.Server;
let targetUrl = '';
const seen: { method: string; url: string; auth: string | null; body: string }[] = [];

beforeAll(async () => {
  target = http.createServer((req, res) => {
    if (req.url === '/boom') { req.socket.destroy(); return; }
    const chunks: Buffer[] = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization ?? null, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, echoed: body }));
    });
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  targetUrl = `http://127.0.0.1:${(target.address() as net.AddressInfo).port}`;
});
afterAll(() => { target.close(); });

function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'r1', deviceId: 'd1', source: 'xhr', startedAt: 1_700_000_000_000,
    method: 'POST', url: `${targetUrl}/v1/items`,
    requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer secret', host: 'example.test', 'content-length': '7' },
    requestBody: '{"a":1}', requestBodySize: 7, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":true}', responseBodySize: 11, responseBodyOmitted: null,
    durationMs: 42, error: null, ...over,
  };
}

// Newest replay entry for a device.
function replayEntry(store: Store, deviceId: string): Entry | undefined {
  return store.entries(deviceId).find((e) => e.source === 'replay');
}

describe('performReplay (T7.1)', () => {
  it('re-sends the captured request, storing a new replay entry with replayOf', async () => {
    const store = new Store();
    store.addEntry(entry());
    const before = seen.length;
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.key.deviceId).toBe('d1');
    expect(result.key.id).not.toBe('r1');
    expect(result.key.id.startsWith('replay-')).toBe(true);

    // The target saw the original method, path, body and captured auth header.
    const hit = seen[before];
    expect(hit.method).toBe('POST');
    expect(hit.url).toBe('/v1/items');
    expect(hit.body).toBe('{"a":1}');
    expect(hit.auth).toBe('Bearer secret');

    // Stored as a fresh entry, source 'replay', linked back to the original.
    const rep = replayEntry(store, 'd1');
    expect(rep).toBeTruthy();
    expect(rep!.source).toBe('replay');
    expect(rep!.replayOf).toEqual({ id: 'r1' });
    expect(rep!.status).toBe(200);
    expect(rep!.responseBody).toContain('"echoed":"{\\"a\\":1}"');
    // hop-by-hop and host/content-length were stripped from the outgoing request.
    expect(rep!.requestHeaders).not.toHaveProperty('host');
    expect(rep!.requestHeaders).not.toHaveProperty('content-length');
    expect(rep!.requestHeaders.authorization).toBe('Bearer secret');
  });

  it('applies overrides (method, url, headers, body)', async () => {
    const store = new Store();
    store.addEntry(entry());
    const before = seen.length;
    const result = await performReplay(store, {
      deviceId: 'd1', id: 'r1',
      overrides: { method: 'put', url: `${targetUrl}/v2/other`, headers: { 'x-test': '1' }, body: 'OVERRIDE' },
    });
    expect(result.ok).toBe(true);
    const hit = seen[before];
    expect(hit.method).toBe('PUT');
    expect(hit.url).toBe('/v2/other');
    expect(hit.body).toBe('OVERRIDE');
    expect(hit.auth).toBeNull(); // override headers replaced the captured set
  });

  it('404 when the entry is unknown', async () => {
    const store = new Store();
    const result = await performReplay(store, { deviceId: 'd1', id: 'nope' });
    expect(result).toEqual({ ok: false, code: 404, message: 'entry not found' });
  });

  it('422 when the original request body was omitted and no override is given', async () => {
    const store = new Store();
    store.addEntry(entry({ requestBody: null, requestBodyOmitted: 'size', requestBodySize: 9_000_000 }));
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(422);
  });

  it('replays an omitted-body request when an override body is supplied', async () => {
    const store = new Store();
    store.addEntry(entry({ requestBody: null, requestBodyOmitted: 'size', requestBodySize: 9_000_000 }));
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1', overrides: { body: 'recovered' } });
    expect(result.ok).toBe(true);
  });

  it('400 on a malformed request body', async () => {
    const store = new Store();
    const bad = await performReplay(store, { id: 'r1' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe(400);
  });

  it('records a network error as an entry with error set, not a throw', async () => {
    const store = new Store();
    store.addEntry(entry({ url: `${targetUrl}/boom` }));
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.error).toBe('network');
    const rep = replayEntry(store, 'd1');
    expect(rep!.error).toBe('network');
    expect(rep!.status).toBeNull();
  });
});

describe('POST /api/replay route (T7.1)', () => {
  let h: CollectorHarness;
  beforeAll(async () => { h = await createCollectorHarness(); });
  afterAll(async () => { await h.close(); });

  it('201 with the new entry key over a bearer (no Origin needed for the CLI)', async () => {
    h.store.addEntry(entry({ id: 'route1' }));
    const res = await fetch(`${h.url}/api/replay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd1', id: 'route1' }),
    });
    expect(res.status).toBe(201);
    const json = await res.json() as { key: { deviceId: string; id: string }; status: number };
    expect(json.key.deviceId).toBe('d1');
    expect(json.status).toBe(200);
    // The replay is queryable as a normal entry.
    const detail = await fetch(`${h.url}/api/entries/d1/${encodeURIComponent(json.key.id)}`, { headers: { authorization: `Bearer ${h.adminToken}` } });
    expect(detail.status).toBe(200);
    expect((await detail.json() as { source: string }).source).toBe('replay');
  });

  it('404 for an unknown entry', async () => {
    const res = await fetch(`${h.url}/api/replay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd1', id: 'ghost' }),
    });
    expect(res.status).toBe(404);
  });

  it('403 for a cookie session without a valid Origin (CSRF guard)', async () => {
    h.store.addEntry(entry({ id: 'route2' }));
    const cookie = await h.login();
    const res = await fetch(`${h.url}/api/replay`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' }, // no Origin
      body: JSON.stringify({ deviceId: 'd1', id: 'route2' }),
    });
    expect(res.status).toBe(403);
  });
});
