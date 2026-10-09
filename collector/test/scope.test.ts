import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store.js';
import { parseHostPattern, parsePatternList, patternMatches, CaptureScope, validateScopeBody, scopeFromEnv, loadScopeFile, saveScopeFile } from '../src/scope.js';
import { performReplay } from '../src/replay.js';
import { loadCaptureFile } from '../src/loadCapture.js';
import { apply, completedInner, startInner } from './fixtures/atlantisWire.js';
import type { Entry } from '../src/types.js';

// U5: host patterns and the capture scope. The scope is enforced inside the
// store, so every source path is exercised here through its real entry point.

describe('host patterns', () => {
  it('parses exact hosts, leading-label wildcards and (scope only) paths', () => {
    expect(parseHostPattern('API.Example.com', { allowPath: false })).toMatchObject({ ok: true, pattern: { host: 'api.example.com', wildcard: false, path: null } });
    expect(parseHostPattern('*.example.com', { allowPath: false })).toMatchObject({ ok: true, pattern: { host: 'example.com', wildcard: true } });
    expect(parseHostPattern('10.0.0.5', { allowPath: false })).toMatchObject({ ok: true });
    expect(parseHostPattern('api.example.com/v1/*', { allowPath: true })).toMatchObject({ ok: true, pattern: { path: '/v1/', prefix: true } });
    expect(parseHostPattern('api.example.com/health', { allowPath: true })).toMatchObject({ ok: true, pattern: { path: '/health', prefix: false } });
  });

  it('rejects schemes, ports, inner wildcards, bad labels and paths where not allowed', () => {
    for (const bad of ['', 'https://a.com', 'a.com:443', '*', 'a.*.com', 'foo*.com', 'a..com', 'a com', '-a.com', '[::1]', 'a.com/x*y']) {
      expect(parseHostPattern(bad, { allowPath: true }).ok, bad).toBe(false);
    }
    expect(parseHostPattern('a.com/x', { allowPath: false }).ok).toBe(false);
  });

  it('a list keeps the valid items and reports the invalid ones', () => {
    const r = parsePatternList('a.com, ,https://b.com,*.c.com', { allowPath: false });
    expect(r.patterns.map((p) => p.raw)).toEqual(['a.com', '*.c.com']);
    expect(r.invalid).toEqual([{ raw: 'https://b.com', message: expect.any(String) }]);
  });

  it('wildcards match any subdomain depth but not the apex; paths match exactly or by prefix', () => {
    const w = parseHostPattern('*.example.com', { allowPath: true });
    if (!w.ok) throw new Error('parse');
    expect(patternMatches(w.pattern, 'a.example.com', '/')).toBe(true);
    expect(patternMatches(w.pattern, 'a.b.EXAMPLE.com', '/')).toBe(true);
    expect(patternMatches(w.pattern, 'example.com', '/')).toBe(false);
    expect(patternMatches(w.pattern, 'badexample.com', '/')).toBe(false);
    const p = parseHostPattern('h.com/v1/*', { allowPath: true });
    const e = parseHostPattern('h.com/v1', { allowPath: true });
    if (!p.ok || !e.ok) throw new Error('parse');
    expect(patternMatches(p.pattern, 'h.com', '/v1/users')).toBe(true);
    expect(patternMatches(p.pattern, 'h.com', '/v2/users')).toBe(false);
    expect(patternMatches(e.pattern, 'h.com', '/v1')).toBe(true);
    expect(patternMatches(e.pattern, 'h.com', '/v1/x')).toBe(false);
  });
});

describe('capture scope verdict', () => {
  it('empty include records everything; exclude wins over include', () => {
    expect(new CaptureScope().verdict('https://any.host/x')).toBeNull();
    const s = new CaptureScope({ include: ['*.example.com'], exclude: ['cdn.example.com', 'api.example.com/health'] });
    expect(s.verdict('https://api.example.com/v1')).toBeNull();
    expect(s.verdict('https://cdn.example.com/a.png')).toBe('excluded');
    expect(s.verdict('https://api.example.com/health?x=1')).toBe('excluded');
    expect(s.verdict('https://other.org/')).toBe('notIncluded');
    expect(s.verdict('wss://live.example.com/socket')).toBeNull();
  });

  it('records what it cannot judge (no URL, unparsable URL)', () => {
    const s = new CaptureScope({ include: ['a.com'], exclude: [] });
    expect(s.verdict(null)).toBeNull();
    expect(s.verdict('not a url')).toBeNull();
  });

  it('PUT validation is strict; env parsing is lenient', () => {
    expect(validateScopeBody({ include: ['a.com'], exclude: [] })).toEqual({ ok: true, value: { include: ['a.com'], exclude: [] } });
    expect(validateScopeBody({ include: ['a.com'] })).toEqual({ ok: true, value: { include: ['a.com'], exclude: [] } });
    expect(validateScopeBody({ include: ['a.com:80'] }).ok).toBe(false);
    expect(validateScopeBody({ include: 'a.com' }).ok).toBe(false);
    expect(validateScopeBody({ include: [], extra: 1 }).ok).toBe(false);
    expect(validateScopeBody(null).ok).toBe(false);
    expect(validateScopeBody({ include: Array.from({ length: 300 }, (_, i) => `h${i}.com`) }).ok).toBe(false);
    expect(scopeFromEnv('a.com,bad:1', '*.b.com')).toEqual({ include: ['a.com'], exclude: ['*.b.com'] });
  });

  it('persists atomically as 0600 and ignores a malformed file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-scope-'));
    try {
      const file = path.join(dir, 'scope.json');
      expect(loadScopeFile(file)).toBeNull();
      saveScopeFile(file, { include: ['a.com'], exclude: ['b.com/x*'] });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(loadScopeFile(file)).toEqual({ include: ['a.com'], exclude: ['b.com/x*'] });
      fs.writeFileSync(file, '{not json');
      expect(loadScopeFile(file)).toBeNull();
      fs.writeFileSync(file, JSON.stringify({ include: ['bad:1'] }));
      expect(loadScopeFile(file)).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---- Every source path goes through the store's scope ------------------------

const SCOPE = { include: ['api.example', '*.keep.test'], exclude: ['noise.keep.test'] };

describe('capture scope in the store', () => {
  it('Atlantis (wire fixtures): an out-of-scope exchange is not stored and counts once across start + completion', () => {
    const store = new Store({ scope: SCOPE });
    apply(store, 'dev-a', 'traffic', completedInner('t1')); // https://api.example/t1: in scope
    const out = (tid: string) => ({ url: `https://other.example/${tid}`, method: 'GET', headers: [] });
    apply(store, 'dev-a', 'traffic', { ...startInner('t2'), request: out('t2') });
    apply(store, 'dev-a', 'traffic', completedInner('t2', { request: out('t2') }));
    expect(store.entries().map((e) => e.id)).toEqual(['t1']);
    expect(store.scopeStatus()).toEqual({ ...SCOPE, dropped: { excluded: 0, notIncluded: 1 } });
  });

  it('WSS ingest: request/response and a WebSocket session with its frames are dropped quietly', () => {
    const store = new Store({ scope: SCOPE });
    store.applyDeviceMessage('dev-x', { type: 'request', id: 'r1', ts: 1, method: 'GET', url: 'https://noise.keep.test/p', headers: {}, body: null, bodySize: 0, source: 'xhr' });
    store.applyDeviceMessage('dev-x', { type: 'response', id: 'r1', ts: 2, status: 200, statusText: 'OK', headers: {}, body: 'x', bodySize: 1, durationMs: 1 });
    store.applyDeviceMessage('dev-x', { type: 'request', id: 'r2', ts: 1, method: 'GET', url: 'https://a.keep.test/p', headers: {}, body: null, bodySize: 0, source: 'xhr' });
    store.applyDeviceMessage('dev-x', { type: 'ws_open', wsId: 'w1', ts: 1, url: 'wss://elsewhere.test/s', protocols: [] });
    store.applyDeviceMessage('dev-x', { type: 'ws_frame', wsId: 'w1', ts: 2, direction: 'in', data: 'hi', size: 2, binary: false });
    store.applyDeviceMessage('dev-x', { type: 'ws_close', wsId: 'w1', ts: 3, code: 1000, reason: '' });
    store.applyDeviceMessage('dev-x', { type: 'ws_open', wsId: 'w2', ts: 1, url: 'wss://live.keep.test/s', protocols: [] });
    expect(store.entries().map((e) => e.id)).toEqual(['r2']);
    expect(store.wsSessions().map((s) => s.wsId)).toEqual(['w2']);
    expect(store.scopeStatus().dropped).toEqual({ excluded: 1, notIncluded: 1 });
    // Scope drops are not retention losses.
    const r = store.retentionCounters();
    expect(r.droppedFrames).toBe(0);
    expect(r.refusedSessions).toBe(0);
  });

  it('replay: the result of an out-of-scope request is sent but not stored', async () => {
    const store = new Store({ scope: { include: [], exclude: [] } });
    const original: Entry = {
      id: 'o1', deviceId: 'd1', source: 'xhr', startedAt: 1, method: 'GET', url: 'https://api.example/x',
      requestHeaders: {}, requestBody: null, requestBodySize: 0, requestBodyOmitted: null,
      status: 200, statusText: 'OK', responseHeaders: {}, responseBody: null, responseBodySize: 0, responseBodyOmitted: null, durationMs: 1, error: null,
    };
    store.addEntry(original);
    store.setScope({ include: [], exclude: ['api.example'] });
    let sent = 0;
    const fetch = (async () => { sent++; return new Response('ok', { status: 200 }); }) as unknown as typeof globalThis.fetch;
    const r = await performReplay(store, { deviceId: 'd1', id: 'o1' }, { fetch });
    expect(sent).toBe(1);
    expect(r).toMatchObject({ ok: true, status: 200, stored: false });
    expect(store.entries().map((e) => e.id)).toEqual(['o1']); // already stored records stay
    expect(store.scopeStatus().dropped.excluded).toBe(1);
    store.setScope({ include: [], exclude: [] });
    expect(await performReplay(store, { deviceId: 'd1', id: 'o1' }, { fetch })).toMatchObject({ ok: true, stored: true });
  });

  it('HAR --load: out-of-scope entries are skipped and not counted in the summary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-scope-har-'));
    try {
      const file = path.join(dir, 'cap.har');
      const he = (url: string) => ({
        startedDateTime: new Date(1000).toISOString(), time: 1,
        request: { method: 'GET', url, httpVersion: 'HTTP/1.1', cookies: [], headers: [], queryString: [], headersSize: -1, bodySize: 0 },
        response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', cookies: [], headers: [], content: { size: 0, mimeType: 'text/plain' }, redirectURL: '', headersSize: -1, bodySize: 0 },
        cache: {}, timings: { send: 0, wait: 1, receive: 0 },
      });
      fs.writeFileSync(file, JSON.stringify({ log: { version: '1.2', creator: { name: 't', version: '1' }, entries: [he('https://api.example/a'), he('https://ads.other/b')] } }));
      const store = new Store({ scope: SCOPE });
      expect(loadCaptureFile(store, file)).toEqual({ entries: 1, sessions: 0, frames: 0 });
      expect(store.entries().map((e) => e.url)).toEqual(['https://api.example/a']);
      expect(store.scopeStatus().dropped.notIncluded).toBe(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a scope change applies to new records only and resets nothing already counted', () => {
    const store = new Store();
    store.addEntry({ id: 'a', deviceId: 'd', source: 'xhr', startedAt: 1, method: 'GET', url: 'https://x.test/', requestHeaders: {}, requestBody: null, requestBodySize: 0, requestBodyOmitted: null, status: null, statusText: '', responseHeaders: {}, responseBody: null, responseBodySize: 0, responseBodyOmitted: null, durationMs: null, error: null });
    store.setScope({ include: ['y.test'], exclude: [] });
    // A completion for the record stored before the change still lands on it.
    store.addEntry({ id: 'a', deviceId: 'd', source: 'xhr', startedAt: 1, method: 'GET', url: 'https://x.test/', requestHeaders: {}, requestBody: null, requestBodySize: 0, requestBodyOmitted: null, status: 204, statusText: '', responseHeaders: {}, responseBody: null, responseBodySize: 0, responseBodyOmitted: null, durationMs: 3, error: null });
    expect(store.entries()[0].status).toBe(204);
    expect(store.scopeStatus().dropped).toEqual({ excluded: 0, notIncluded: 0 });
  });
});
