import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { CollectorIdentity } from '../src/security/types.js';
import { createTestIdentity, withAtlantisCollector } from './fixtures/atlantisWire.js';

// P2: GET /api/pairing?host= overrides the advertised host for one response, only
// to a host the certificate SAN covers; the route stays admin-only.

let identity: CollectorIdentity;
let dispose: () => Promise<void>;
beforeAll(async () => { ({ identity, dispose } = await createTestIdentity()); });
afterAll(async () => { await dispose(); });

describe('GET /api/pairing?host= (P2)', () => {
  it('overrides the host for this response only when the SAN covers it', () => withAtlantisCollector(identity, async ({ get }) => {
    const plain = await (await get('/api/pairing')).json();
    expect(plain.host).toBe('192.168.9.9');
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const res = await get(`/api/pairing?host=${encodeURIComponent(host)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body).toEqual({ ...plain, host });
    }
    // Not sticky: the next plain request advertises the default host again.
    expect((await (await get('/api/pairing')).json()).host).toBe('192.168.9.9');
  }));

  it('400 bad_request when the host is outside the SAN or malformed', () => withAtlantisCollector(identity, async ({ get }) => {
    for (const host of ['10.0.2.2', 'evil.example', '', 'bad host;x']) {
      const res = await get(`/api/pairing?host=${encodeURIComponent(host)}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_request' });
    }
  }));

  it('stays admin-only: the reader token gets 403 with or without host', () => withAtlantisCollector(identity, async ({ h }) => {
    for (const q of ['', '?host=127.0.0.1']) {
      const res = await fetch(`${h.url}/api/pairing${q}`, { headers: { authorization: `Bearer ${h.readerToken}` } });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden_scope', required: 'admin' });
    }
  }));
});
