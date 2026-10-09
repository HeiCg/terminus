import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Store } from '../src/store.js';
import { nameWords, isSensitiveName } from '../src/security/sensitiveNames.js';
import { isHostname } from '../src/security/types.js';
import type { EntryInput } from '../src/types.js';
import type { CollectorIdentity } from '../src/security/types.js';
import { createCollectorHarness } from './fixtures/harness.js';
import { createTestIdentity, until, withAtlantisCollector, envelope, completedInner } from './fixtures/atlantisWire.js';

// Regressions for the 0.2.0 pre-release review: two event-loop freezes on caller
// input, a wait that missed traffic once an alias appeared, and `ambiguous`/clear
// interactions with aliases and live overlaps.

const input = (id: string, deviceId: string): EntryInput => ({
  id, deviceId, source: 'atlantis', startedAt: 1, method: 'GET', url: `https://api.example/${id}`,
  requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
  status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: null, responseBodySize: 0,
  responseBodyOmitted: null, durationMs: 1, error: null,
});
const hello = (deviceId: string, atlantisDeviceKey?: string) => ({ type: 'hello' as const, deviceId, platform: 'ios' as const, appVersion: '1.0', buildProfile: 'dev', dropped: 0, ts: 100, ...(atlantisDeviceKey ? { atlantisDeviceKey } : {}) });

describe('linear-cost name and host checks', () => {
  it('a 1 MiB capital-letter key is split in bounded time', () => {
    const key = 'A'.repeat(1 << 20);
    const t0 = performance.now();
    nameWords(key); isSensitiveName(key, 'body');
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it('long names are still judged on their prefix', () => {
    expect(isSensitiveName(`password_${'x'.repeat(5000)}`, 'body')).toBe(true);
  });

  it('isHostname rejects a long non-matching value without backtracking', () => {
    const evil = `${'a'.repeat(60)}!`;
    const t0 = performance.now();
    expect(isHostname(evil)).toBe(false);
    expect(isHostname('x'.repeat(300))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('isHostname keeps accepting what it accepted', () => {
    for (const h of ['mac', 'mac.local', 'api.example.com', 'host-1.lan.', '192.168.1.10', 'a']) expect(isHostname(h)).toBe(true);
    for (const h of ['', '-a', 'a..b', 'a b', 'a_b.c']) expect(isHostname(h)).toBe(false);
  });
});

describe('alias learned during a wait', () => {
  it('a wait scoped to the Atlantis key catches traffic stored under the canonical device', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.touchDevice({ deviceId: 'ATL', platform: 'ios', appVersion: '', buildProfile: 'atlantis', dropped: 0, lastSeen: 1 }, 'atlantis');
      const pending = fetch(`${h.url}/api/entries/wait?afterSeq=0&device=ATL&timeoutMs=3000`, { headers: { authorization: `Bearer ${h.adminToken}` } });
      await until(() => h.activeWaits() === 1);
      h.store.applyDeviceMessage('HID', hello('HID', 'ATL'));
      h.store.addEntryInput(input('e1', 'ATL'));
      const body = await (await pending).json() as { matched: boolean; items: { id: string; deviceId: string }[] };
      expect(body.matched).toBe(true);
      expect(body.items.map((e) => [e.id, e.deviceId])).toEqual([['e1', 'HID']]);
    } finally { await h.close(); }
  });
});

describe('clear and aliases', () => {
  it('clear(aliasKey) clears the canonical device', () => {
    const s = new Store();
    s.applyDeviceMessage('HID', hello('HID', 'ATL'));
    s.addEntryInput(input('e1', 'ATL'));
    expect(s.entries('HID')).toHaveLength(1);
    s.clear('ATL');
    expect(s.entries('HID')).toHaveLength(0);
  });
});

let identity: CollectorIdentity;
let dispose: () => Promise<void>;
beforeAll(async () => { ({ identity, dispose } = await createTestIdentity()); });
afterAll(async () => { await dispose(); });

describe('ambiguous across a clear', () => {
  it('stays set when the overlap is still live, and lowers once it is gone', () => withAtlantisCollector(identity, async ({ h, client }) => {
    const a = await client('com.acme.app');
    const b = await client('com.acme.app');
    await until(() => h.store.devices()[0]?.ambiguous === true);
    h.store.clear();
    expect(h.store.devices()[0].ambiguous).toBe(true);
    a.write(envelope('com.acme.app', 'traffic', completedInner('x1')));
    await until(() => h.store.entries('com.acme.app').length === 1);
    b.destroy();
    await until(() => { h.store.clear(); return h.store.devices()[0].ambiguous === undefined; });
    a.destroy();
  }));
});
