import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tempStateDir, settingsFor, connect, call, text } from './helpers.js';

// Failure mapping against a scripted fake collector: every failure is an
// `isError: true` result with a message the model can act on, never a crash.

type Fake = { host: string; port: number; hits: string[]; close: () => Promise<void> };

const HEALTH = { status: 'ok', version: '0.2.0', apiVersion: 1, capabilities: ['seq', 'reader-token', 'device-identity', 'filters', 'wait', 'redaction-marker'] };

async function fakeCollector(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void, health: unknown = HEALTH): Promise<Fake> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(health)); return; }
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { host: '127.0.0.1', port, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const jsonReply = (status: number, body: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

let dir: string;
beforeEach(() => { dir = tempStateDir(); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

async function withFake(fake: Fake, fn: (c: Awaited<ReturnType<typeof connect>>) => Promise<void>): Promise<void> {
  const c = await connect(settingsFor(fake, { token: 'tok', stateDir: dir }));
  try { await fn(c); } finally { await c.close(); await fake.close(); }
}

describe('error mapping', () => {
  it('403 forbidden_scope', async () => {
    await withFake(await fakeCollector(jsonReply(403, { error: 'forbidden_scope', required: 'admin' })), async (c) => {
      const r = await call(c, 'terminus_status');
      expect(r.isError).toBe(true);
      expect(text(r)).toBe('forbidden (403 forbidden_scope): GET /api/status needs the admin token, and the configured token is the read-only reader token.');
    });
  });

  it('401', async () => {
    await withFake(await fakeCollector((_q, res) => { res.writeHead(401); res.end(); }), async (c) => {
      const r = await call(c, 'terminus_devices');
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('authentication failed (401)');
    });
  });

  it('409 stale_cursor on a wait', async () => {
    await withFake(await fakeCollector(jsonReply(409, { error: 'stale_cursor', epoch: 'E2', lastSeq: 7 })), async (c) => {
      const r = await call(c, 'terminus_wait', { afterSeq: 99, epoch: 'E1' });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('current epoch E2, lastSeq 7');
      expect(text(r)).toContain('Call terminus_status');
    });
  });

  it('429 too_many_waits', async () => {
    await withFake(await fakeCollector(jsonReply(429, { error: 'too_many_waits', limit: 16 })), async (c) => {
      const r = await call(c, 'terminus_wait', { afterSeq: 0 });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('too many pending waits on the collector (429, limit 16)');
    });
  });

  it('connection refused', async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r())); // nothing listens there now
    const c = await connect(settingsFor({ host: '127.0.0.1', port }, { token: 'tok', stateDir: dir }));
    try {
      for (const name of ['terminus_status', 'terminus_entries']) {
        const r = await call(c, name);
        expect(r.isError, name).toBe(true);
        expect(text(r), name).toContain(`cannot reach the Terminus collector at 127.0.0.1:${port}`);
      }
    } finally { await c.close(); }
  });
});

describe('old-collector detection', () => {
  it('every tool reports "collector too old" when /health has no apiVersion, and never calls the API', async () => {
    const fake = await fakeCollector(jsonReply(200, { items: [] }), { status: 'ok' });
    await withFake(fake, async (c) => {
      const calls: [string, Record<string, unknown>][] = [
        ['terminus_status', {}], ['terminus_devices', {}], ['terminus_entries', {}],
        ['terminus_entry', { deviceId: 'd', id: 'i' }], ['terminus_wait', { afterSeq: 0 }],
        ['terminus_ws_sessions', {}], ['terminus_ws_frames', { deviceId: 'd', wsId: 'w' }],
      ];
      for (const [name, args] of calls) {
        const r = await call(c, name, args);
        expect(r.isError, name).toBe(true);
        expect(text(r), name).toBe('Terminus collector too old: needs 0.2.0+');
      }
      expect(fake.hits.every((h) => h === 'GET /health')).toBe(true);
    });
  });

  it('q is never sent to a collector without the query capability', async () => {
    const fake = await fakeCollector(jsonReply(200, { items: [], nextSeq: 0, lastSeq: 0, epoch: 'E', gap: false, hasMore: false }));
    await withFake(fake, async (c) => {
      const r = await call(c, 'terminus_entries', { last: 5, q: 'status >= 500' });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('lacks the capability "query"');
      const w = await call(c, 'terminus_wait', { afterSeq: 0, epoch: 'E', q: 'status >= 500' });
      expect(w.isError).toBe(true);
      expect(text(w)).toContain('"query"');
      // Without q the same collector still answers, and no request ever carried q=.
      expect((await call(c, 'terminus_entries', { last: 5 })).isError).toBeFalsy();
      expect(fake.hits.some((x) => x.includes('q='))).toBe(false);
    });
  });

  it('q passes through as q= when the collector advertises query', async () => {
    const fake = await fakeCollector(jsonReply(200, { items: [], nextSeq: 0, lastSeq: 0, epoch: 'E', gap: false, hasMore: false }),
      { ...HEALTH, capabilities: [...HEALTH.capabilities, 'query'] });
    await withFake(fake, async (c) => {
      expect((await call(c, 'terminus_entries', { last: 5, q: 'status >= 500' })).isError).toBeFalsy();
      expect(fake.hits.find((x) => x.startsWith('GET /api/entries?'))).toContain(`q=${encodeURIComponent('status >= 500').replace(/%20/g, '+')}`);
    });
  });

  it('a missing capability is named', async () => {
    const fake = await fakeCollector(jsonReply(200, {}), { ...HEALTH, capabilities: ['seq'] });
    await withFake(fake, async (c) => {
      const r = await call(c, 'terminus_wait', { afterSeq: 0 });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('lacks the capability "wait", "filters"');
    });
  });
});
