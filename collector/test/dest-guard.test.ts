import { describe, it, expect } from 'vitest';
import { createDestGuard, createMetadataResolver } from '../src/proxy/destGuard.js';

const lookupOf = (table: Record<string, string[]>) => async (h: string) => {
  const a = table[h];
  if (!a) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

describe('proxy destination guard', () => {
  const lookup = lookupOf({ 'mixed.test': ['93.184.216.34', '127.0.0.1'], 'v6first.test': ['2001:db8::1', '93.184.216.34'], 'ok.test': ['93.184.216.34'] });
  const guard = createDestGuard({ allowLocal: false, lookup, ownAddresses: () => ['192.168.1.10', 'fe80::1', '::ffff:10.0.0.7'] });

  it('refuses metadata, loopback, unspecified, link-local and own addresses, in any spelling', async () => {
    for (const h of ['169.254.169.254', 'metadata.google.internal', '127.0.0.1', '2130706433', '[::1]', '0.0.0.0', '::', 'fe80::2', '192.168.1.10', '10.0.0.7', '::ffff:192.168.1.10']) {
      expect((await guard.check(h)).ok, h).toBe(false);
    }
  });

  it('refuses a name when ANY address it resolves to is refused, and reports DNS failures', async () => {
    expect(await guard.check('mixed.test')).toMatchObject({ ok: false, reason: 'resolves to loopback' });
    expect(await guard.check('nope.test')).toMatchObject({ ok: false, reason: 'dns ENOTFOUND' });
  });

  it('returns the checked address to dial (IPv4 first) and passes ordinary LAN/public addresses', async () => {
    expect(await guard.check('ok.test')).toEqual({ ok: true, address: '93.184.216.34' });
    expect(await guard.check('v6first.test')).toEqual({ ok: true, address: '93.184.216.34' });
    expect(await guard.check('192.168.1.20')).toEqual({ ok: true, address: '192.168.1.20' });
    expect(await guard.check('0xc0a80114')).toEqual({ ok: true, address: '192.168.1.20' });
  });

  it('allowLocal lifts the local ranges but never the metadata range', async () => {
    const open = createDestGuard({ allowLocal: true, lookup, ownAddresses: () => ['192.168.1.10'] });
    expect(await open.check('127.0.0.1')).toEqual({ ok: true, address: '127.0.0.1' });
    expect(await open.check('192.168.1.10')).toMatchObject({ ok: true });
    expect(await open.check('169.254.169.254')).toMatchObject({ ok: false });
    expect(await open.check('[64:ff9b::a9fe:a9fe]')).toMatchObject({ ok: false });
    expect(await open.check('metadata')).toMatchObject({ ok: false });
  });

  it('the HTTP metadata resolver checks names via DNS and caches the answer', async () => {
    let calls = 0;
    const r = createMetadataResolver(async () => { calls++; return [{ address: '169.254.169.254', family: 4 }]; });
    expect(await r('evil.test')).toBe(true);
    expect(await r('EVIL.test')).toBe(true);
    expect(calls).toBe(1);
    expect(await r('10.0.0.1')).toBe(false);
    expect(await r('metadata.google.internal')).toBe(true);
    const failing = createMetadataResolver(async () => { throw new Error('dns down'); });
    expect(await failing('x.test')).toBe(false);
  });
});
