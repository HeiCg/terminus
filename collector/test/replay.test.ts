import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { Store } from '../src/store.js';
import { performReplay, stripCredentials } from '../src/replay.js';
import { configureRedaction } from '../src/security/sensitiveNames.js';
import { createCollectorHarness, type CollectorHarness } from './fixtures/harness.js';
import type { Entry, EntryInput } from '../src/types.js';
import { PER_BODY_MAX } from '../src/atlantis/decode.js';
import { CAPABILITIES } from '../src/version.js';

// A local target the replay fetch actually hits: it echoes the method, url, a
// chosen request header and the request body back as JSON so a test can assert
// what the collector re-sent. `/boom` closes the socket to force a network error.
let target: http.Server;
let targetUrl = '';
const seen: { method: string; url: string; auth: string | null; cookie: string | null; headers: http.IncomingHttpHeaders; body: string; raw: Buffer }[] = [];
// Fixed non-UTF-8 bytes the `/octet` route answers with (a NUL and invalid UTF-8).
const OCTET = Buffer.from([0x00, 0xff, 0xfe, 0x10, 0x80, 0x41, 0x42, 0x00]);
// UTF-8-valid, NUL-free bytes labelled as protobuf: they must be stored verbatim,
// never run through the text redactor (which would rewrite the `token=` value).
const PROTO_TEXTLIKE = Buffer.from('token="abcdef"', 'utf8');

beforeAll(async () => {
  target = http.createServer((req, res) => {
    if (req.url === '/boom') { req.socket.destroy(); return; }
    if (req.url === '/octet') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(OCTET);
      return;
    }
    if (req.url === '/proto') {
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end(PROTO_TEXTLIKE);
      return;
    }
    if (req.url === '/login') {
      // A response carrying credentials on both channels the redactor covers.
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=s3cr3t', 'x-request-id': 'rid-1' });
      res.end('{"access_token":"tok123","user":"u"}');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = raw.toString('utf8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null, headers: req.headers, body, raw });
      if (req.url === '/bin-echo') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(raw);
        return;
      }
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

// A captured exchange whose request body is binary (stored as bytes, `binary`).
function binaryInput(bytes: Uint8Array, over: Partial<EntryInput> = {}): EntryInput {
  return {
    id: 'b1', deviceId: 'd1', source: 'xhr', startedAt: 1_700_000_000_000,
    method: 'POST', url: `${targetUrl}/bin-echo`,
    requestHeaders: { 'content-type': 'application/octet-stream' },
    requestBytes: bytes, requestBodySize: bytes.length, requestBodyOmitted: 'binary',
    status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/json' },
    responseBytes: null, responseBodySize: 0, responseBodyOmitted: null,
    durationMs: 1, error: null, ...over,
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
    // `keep` preserves the pre-T8.1 verbatim behaviour this test exercises; the
    // default-strip path is covered by the credential-stripping suite below.
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1', credentials: 'keep' });
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
    expect(rep!.replayOf).toEqual({ id: 'r1', credentials: 'keep', stripped: [] });
    expect(rep!.status).toBe(200);
    expect(rep!.responseBody).toContain('"echoed":"{\\"a\\":1}"');
    // hop-by-hop and host/content-length were stripped from the outgoing request.
    expect(rep!.requestHeaders).not.toHaveProperty('host');
    expect(rep!.requestHeaders).not.toHaveProperty('content-length');
    // T6: the stored copy is redacted like every other source; only the wire saw the value.
    expect(rep!.requestHeaders.authorization).toBe('***');
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

// An entry carrying every kind of credential the strip must reach: two exact-name
// headers, an `x-*`-pattern header, and two credential query params, plus a benign
// header/param that must survive.
function credentialEntry(over: Partial<Entry> = {}): Entry {
  return entry({
    url: `${targetUrl}/v1/items?token=abc&access_token=xyz&page=2`,
    requestHeaders: {
      'content-type': 'application/json',
      authorization: 'Bearer secret',
      cookie: 'session=deadbeef',
      'x-refresh-token': 'r0tat3',
      'x-request-id': 'keep-me',
    },
    ...over,
  });
}

describe('stripCredentials (T8.1)', () => {
  it('removes credential headers and query params, keeps benign ones, reports names', () => {
    const r = stripCredentials(
      { authorization: 'Bearer s', Cookie: 'a=b', 'X-Api-Key': 'k', 'x-signing-secret': 'z', 'content-type': 'application/json' },
      'https://h.test/p?api_key=1&sig=2&keep=3&nested_key=4',
      new Set(),
    );
    expect(r.headers).toEqual({ 'content-type': 'application/json' });
    // Header names are reported lowercased; query params carry a `?` marker.
    expect(new Set(r.stripped)).toEqual(new Set(['authorization', 'cookie', 'x-api-key', 'x-signing-secret', '?api_key', '?sig']));
    const u = new URL(r.url);
    expect(u.searchParams.get('keep')).toBe('3');
    expect(u.searchParams.has('api_key')).toBe(false);
    expect(u.searchParams.has('sig')).toBe(false);
    // `nested_key` does not match the exact list nor the `x-*` pattern: it survives.
    expect(u.searchParams.get('nested_key')).toBe('4');
  });

  it('still strips everything the pre-P5 replay list stripped (pin)', () => {
    const oldHeaders = ['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token',
      'x-monkey', 'x-author', 'x-signing-secret', 'X-Refresh-Token'];
    const oldQuery = ['token', 'access_token', 'api_key', 'apikey', 'key', 'auth', 'signature', 'sig', 'x-monkey', 'KEY'];
    configureRedaction({ allow: [...oldHeaders, ...oldQuery] }); // the old list ignores the allow config
    try {
      const r = stripCredentials(Object.fromEntries(oldHeaders.map((h) => [h, 'v'])),
        `https://h.test/p?${oldQuery.map((q) => `${q}=v`).join('&')}`, new Set());
      expect(r.headers).toEqual({});
      expect(new URL(r.url).search).toBe('');
    } finally { configureRedaction({}); }
  });

  it('also strips the shared P5 names (word matcher and legacy client/uid)', () => {
    const r = stripCredentials({ 'X-Session-Id': 's', client: 'c', uid: 'u', accept: 'json' },
      'https://h.test/p?nextPageToken=t&client_id=c&page=2', new Set());
    expect(r.headers).toEqual({ accept: 'json' });
    expect(new Set(r.stripped)).toEqual(new Set(['x-session-id', 'client', 'uid', '?nextpagetoken', '?client_id']));
    expect(new URL(r.url).search).toBe('?page=2');
  });

  it('TERMINUS_REDACT_ALLOW exempts a shared-matcher name from the strip', () => {
    configureRedaction({ allow: ['nextPageToken'] });
    try {
      const r = stripCredentials({}, 'https://h.test/p?nextPageToken=t', new Set());
      expect(r.stripped).toEqual([]);
    } finally { configureRedaction({}); }
  });

  it('never removes a name the caller protected (explicit override)', () => {
    const r = stripCredentials({ authorization: 'Bearer keep' }, 'https://h.test/', new Set(['authorization']));
    expect(r.headers.authorization).toBe('Bearer keep');
    expect(r.stripped).toEqual([]);
  });
});

describe('performReplay credential stripping (T8.1)', () => {
  it('strips captured credentials by default and reports them', async () => {
    const store = new Store();
    store.addEntry(credentialEntry());
    const before = seen.length;
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const hit = seen[before];
    expect(hit.auth).toBeNull();
    expect(hit.cookie).toBeNull();
    expect(hit.headers['x-refresh-token']).toBeUndefined();
    expect(hit.headers['x-request-id']).toBe('keep-me'); // benign header survives
    // Credential query params are gone from the outgoing URL; `page` stays.
    expect(hit.url).toBe('/v1/items?page=2');

    expect(new Set(result.stripped)).toEqual(new Set(['authorization', 'cookie', 'x-refresh-token', '?token', '?access_token']));
    const rep = replayEntry(store, 'd1');
    expect(rep!.replayOf?.credentials).toBe('strip');
    expect(new Set(rep!.replayOf?.stripped)).toEqual(new Set(result.stripped));
    // The stored replay entry also has the credentials scrubbed from its URL/headers.
    expect(rep!.requestHeaders).not.toHaveProperty('authorization');
    expect(rep!.url).toBe(`${targetUrl}/v1/items?page=2`);
  });

  it('keep re-sends the captured credentials verbatim with an empty stripped list', async () => {
    const store = new Store();
    store.addEntry(credentialEntry());
    const before = seen.length;
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1', credentials: 'keep' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hit = seen[before];
    expect(hit.auth).toBe('Bearer secret');
    expect(hit.cookie).toBe('session=deadbeef');
    expect(hit.url).toContain('token=abc');
    expect(result.stripped).toEqual([]);
    expect(replayEntry(store, 'd1')!.replayOf?.credentials).toBe('keep');
  });

  it('an explicit override header survives the default strip (the caller chose it)', async () => {
    const store = new Store();
    store.addEntry(credentialEntry());
    const before = seen.length;
    const result = await performReplay(store, {
      deviceId: 'd1', id: 'r1',
      overrides: { headers: { authorization: 'Bearer chosen', 'content-type': 'application/json' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen[before].auth).toBe('Bearer chosen');
    expect(result.stripped).not.toContain('authorization');
  });
});

// T6: the replay result is stored through the same redactor as the other sources
// (URL query, headers, text bodies on both sides) and carries the `redacted`
// marker; the request that actually leaves keeps what the credential mode decided.
describe('performReplay stores a redacted result (T6)', () => {
  it('keep: the wire gets the captured credentials, the stored request side is masked', async () => {
    const store = new Store();
    store.addEntry(credentialEntry());
    const before = seen.length;
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1', credentials: 'keep' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hit = seen[before];
    expect(hit.auth).toBe('Bearer secret');
    expect(hit.url).toBe('/v1/items?token=abc&access_token=xyz&page=2');

    const rep = store.entry('d1', result.key.id)!;
    expect(rep.requestHeaders.authorization).toBe('***');
    expect(rep.requestHeaders.cookie).toBe('***');
    expect(rep.requestHeaders['x-refresh-token']).toBe('***');
    expect(rep.requestHeaders['x-request-id']).toBe('keep-me');
    const u = new URL(rep.url);
    expect(u.searchParams.get('token')).toBe('***');
    expect(u.searchParams.get('access_token')).toBe('***');
    expect(u.searchParams.get('page')).toBe('2');
    expect(rep.redacted?.request).toBe(true);
  });

  it('an override body is sent verbatim but stored masked', async () => {
    const store = new Store();
    store.addEntry(entry());
    const before = seen.length;
    const result = await performReplay(store, {
      deviceId: 'd1', id: 'r1',
      overrides: { headers: { 'content-type': 'application/json' }, body: '{"user":"u","password":"hunter2"}' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen[before].body).toBe('{"user":"u","password":"hunter2"}');
    const rep = store.entry('d1', result.key.id)!;
    expect(rep.requestBody).toBe('{"user":"u","password":"***"}');
    // The target echoes the body back inside a JSON string: the response pass reaches it too.
    expect(rep.responseBody).not.toContain('hunter2');
    expect(rep.redacted).toEqual({ request: true, response: true });
  });

  it('masks credentials in the response headers and body', async () => {
    const store = new Store();
    store.addEntry(entry({ method: 'GET', url: `${targetUrl}/login`, requestHeaders: { accept: 'application/json' }, requestBody: null, requestBodySize: 0 }));
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rep = store.entry('d1', result.key.id)!;
    expect(rep.responseHeaders['set-cookie']).toBe('***');
    expect(rep.responseHeaders['x-request-id']).toBe('rid-1');
    expect(rep.responseBody).toBe('{"access_token":"***","user":"u"}');
    expect(rep.responseBodySize).toBe(Buffer.byteLength('{"access_token":"***","user":"u"}'));
    expect(rep.redacted).toEqual({ request: false, response: true });
  });

  it('a clean replay carries no redacted marker', async () => {
    const store = new Store();
    store.addEntry(entry({ method: 'GET', url: `${targetUrl}/v1/plain?page=2`, requestHeaders: { accept: 'application/json' }, requestBody: null, requestBodySize: 0 }));
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rep = store.entry('d1', result.key.id)!;
    expect(rep.redacted).toBeUndefined();
    expect(rep.url).toBe(`${targetUrl}/v1/plain?page=2`);
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

  it('201 response reports the stripped credential names (T8.1)', async () => {
    h.store.addEntry(credentialEntry({ id: 'creds1' }));
    const res = await fetch(`${h.url}/api/replay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd1', id: 'creds1' }),
    });
    expect(res.status).toBe(201);
    const json = await res.json() as { stripped: string[] };
    expect(new Set(json.stripped)).toEqual(new Set(['authorization', 'cookie', 'x-refresh-token', '?token', '?access_token']));
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

// U4: binary-safe replay. `overrides.bodyBase64` carries raw bytes, a captured
// binary request body replays as-is, and binary responses are stored as bytes.
describe('performReplay binary bodies (U4)', () => {
  it('overrides.bodyBase64 reaches the target byte-exact and the response is stored as bytes', async () => {
    const store = new Store();
    store.addEntry(entry({ url: `${targetUrl}/bin-echo` }));
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80, 0x0a, 0x00, 0xc3]);
    const before = seen.length;
    const result = await performReplay(store, {
      deviceId: 'd1', id: 'r1', overrides: { headers: { 'content-type': 'application/octet-stream' }, bodyBase64: bytes.toString('base64') },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.compare(seen[before].raw, bytes)).toBe(0);
    const req = store.entryBody('d1', result.key.id, 'request')!;
    expect(req.state).toBe('captured');
    expect(req.encoding).toBe('binary');
    expect(Buffer.compare(Buffer.from(req.bytes!), bytes)).toBe(0);
    const res = store.entryBody('d1', result.key.id, 'response')!;
    expect(res.state).toBe('captured');
    expect(res.encoding).toBe('binary');
    expect(Buffer.compare(Buffer.from(res.bytes!), bytes)).toBe(0);
  });

  it('400 when both overrides.body and overrides.bodyBase64 are given', async () => {
    const store = new Store();
    store.addEntry(entry());
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1', overrides: { body: 'x', bodyBase64: 'eA==' } });
    expect(result).toEqual({ ok: false, code: 400, message: 'pass only one of overrides.body and overrides.bodyBase64' });
  });

  it('400 when overrides.bodyBase64 is not base64', async () => {
    const store = new Store();
    store.addEntry(entry());
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1', overrides: { bodyBase64: 'not base64!' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(400);
  });

  it('413 when an override body is over the per-body cap (bytes, either field)', async () => {
    const store = new Store();
    store.addEntry(entry());
    const big = Buffer.alloc(PER_BODY_MAX + 1, 0x61);
    const viaB64 = await performReplay(store, { deviceId: 'd1', id: 'r1', overrides: { bodyBase64: big.toString('base64') } });
    expect(viaB64.ok).toBe(false);
    if (!viaB64.ok) expect(viaB64.code).toBe(413);
    const viaText = await performReplay(store, { deviceId: 'd1', id: 'r1', overrides: { body: big.toString('utf8') } });
    expect(viaText.ok).toBe(false);
    if (!viaText.ok) expect(viaText.code).toBe(413);
    // Exactly at the cap is accepted.
    const atCap = await performReplay(store, { deviceId: 'd1', id: 'r1', overrides: { bodyBase64: Buffer.alloc(PER_BODY_MAX, 0x61).toString('base64') } });
    expect(atCap.ok).toBe(true);
  });

  it('a captured binary request body is replayed as-is without an override', async () => {
    const store = new Store();
    const bytes = new Uint8Array([0xde, 0xad, 0x00, 0xbe, 0xef, 0xff]);
    store.addEntryInput(binaryInput(bytes));
    const before = seen.length;
    const result = await performReplay(store, { deviceId: 'd1', id: 'b1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.compare(seen[before].raw, Buffer.from(bytes))).toBe(0);
    const req = store.entryBody('d1', result.key.id, 'request')!;
    expect(req.encoding).toBe('binary');
    expect(Buffer.compare(Buffer.from(req.bytes!), Buffer.from(bytes))).toBe(0);
  });

  it('an omitted (not retained) request body still answers 422 with a clear message', async () => {
    const store = new Store();
    store.addEntryInput(binaryInput(new Uint8Array(0), { requestBytes: null, requestBodyOmitted: 'budget', requestBodySize: 4096 }));
    const result = await performReplay(store, { deviceId: 'd1', id: 'b1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(422);
    expect(result.message).toContain('budget');
    expect(result.message).toContain('overrides.bodyBase64');
  });

  it('a binary response is stored byte-exact with the binary encoding', async () => {
    const store = new Store();
    store.addEntry(entry({ method: 'GET', url: `${targetUrl}/octet`, requestHeaders: {}, requestBody: null, requestBodySize: 0 }));
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const res = store.entryBody('d1', result.key.id, 'response')!;
    expect(res.state).toBe('captured');
    expect(res.encoding).toBe('binary');
    expect(Buffer.compare(Buffer.from(res.bytes!), OCTET)).toBe(0);
    expect(store.entry('d1', result.key.id)!.responseBodySize).toBe(OCTET.length);
  });

  it('a binary content type is stored verbatim even when its bytes are valid UTF-8', async () => {
    const store = new Store();
    store.addEntry(entry({ method: 'GET', url: `${targetUrl}/proto`, requestHeaders: {}, requestBody: null, requestBodySize: 0 }));
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const res = store.entryBody('d1', result.key.id, 'response')!;
    expect(res.encoding).toBe('binary');
    expect(Buffer.compare(Buffer.from(res.bytes!), PROTO_TEXTLIKE)).toBe(0);
    expect(store.entry('d1', result.key.id)!.redacted).toBeUndefined();
  });

  it('a text response is still redacted and marked', async () => {
    const store = new Store();
    store.addEntry(entry({ method: 'GET', url: `${targetUrl}/login`, requestHeaders: { accept: 'application/json' }, requestBody: null, requestBodySize: 0 }));
    const result = await performReplay(store, { deviceId: 'd1', id: 'r1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const res = store.entryBody('d1', result.key.id, 'response')!;
    expect(res.encoding).toBe('utf8');
    expect(Buffer.from(res.bytes!).toString('utf8')).toBe('{"access_token":"***","user":"u"}');
    expect(store.entry('d1', result.key.id)!.redacted?.response).toBe(true);
  });

  it('a text override body is still redacted when stored (bodyBase64 of JSON too)', async () => {
    const store = new Store();
    store.addEntry(entry());
    const json = '{"password":"hunter2"}';
    const before = seen.length;
    const result = await performReplay(store, {
      deviceId: 'd1', id: 'r1',
      overrides: { headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from(json).toString('base64') },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen[before].body).toBe(json);
    expect(store.entry('d1', result.key.id)!.requestBody).toBe('{"password":"***"}');
  });
});

describe('performReplay protected override headers (U4)', () => {
  it('an override header equal to the captured value is still stripped (it was not chosen)', async () => {
    const store = new Store();
    store.addEntry(credentialEntry());
    const before = seen.length;
    const result = await performReplay(store, {
      deviceId: 'd1', id: 'r1',
      overrides: { headers: { authorization: 'Bearer secret', 'x-request-id': 'keep-me', 'x-extra': '1' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen[before].auth).toBeNull();
    expect(seen[before].headers['x-extra']).toBe('1');
    expect(result.stripped).toContain('authorization');
  });
});

describe('POST /api/replay binary (U4)', () => {
  it('advertises replay-bytes', () => { expect(CAPABILITIES).toContain('replay-bytes'); });

  let h: CollectorHarness;
  beforeAll(async () => { h = await createCollectorHarness(); });
  afterAll(async () => { await h.close(); });
  const post = (body: unknown) => fetch(`${h.url}/api/replay`, {
    method: 'POST',
    headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('413 for an override body over the cap, 400 for both body fields', async () => {
    h.store.addEntry(entry({ id: 'cap1' }));
    const big = await post({ deviceId: 'd1', id: 'cap1', overrides: { bodyBase64: Buffer.alloc(PER_BODY_MAX + 1).toString('base64') } });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toContain('cap');
    const both = await post({ deviceId: 'd1', id: 'cap1', overrides: { body: 'a', bodyBase64: 'YQ==' } });
    expect(both.status).toBe(400);
  });

  it('201 for bodyBase64, and the stored binary body reads back over the body route', async () => {
    h.store.addEntry(entry({ id: 'bin1', url: `${targetUrl}/bin-echo` }));
    const bytes = Buffer.from([1, 2, 3, 0, 255]);
    const res = await post({ deviceId: 'd1', id: 'bin1', overrides: { bodyBase64: bytes.toString('base64') } });
    expect(res.status).toBe(201);
    const { key } = await res.json() as { key: { id: string } };
    const body = await fetch(`${h.url}/api/entries/d1/${encodeURIComponent(key.id)}/body?side=response`, { headers: { authorization: `Bearer ${h.adminToken}` } });
    expect(body.headers.get('content-type')).toBe('application/octet-stream');
    expect(Buffer.compare(Buffer.from(await body.arrayBuffer()), bytes)).toBe(0);
  });
});
