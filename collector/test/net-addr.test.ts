import { describe, it, expect } from 'vitest';
import { parseIpLiteral, parseIpv4Loose, parseIpv6, isMetadataAddress, isMetadataName, isMetadataHost, localAddressKind } from '../src/netAddr.js';

// 0.3.0 review: the metadata / local-destination checks compared literal strings,
// so other spellings of the same address slipped through.

describe('IP literal normalisation', () => {
  it('reads every inet_aton IPv4 form', () => {
    for (const s of ['169.254.169.254', '2852039166', '169.16689662', '169.254.43518', '0251.0376.0251.0376', '0xa9.0xfe.0xa9.0xfe', '0xa9fea9fe', '0xA9FEA9FE', '169.254.169.254.']) {
      expect(parseIpLiteral(s)?.address, s).toBe('169.254.169.254');
    }
    expect(parseIpv4Loose('127.1')).toBe(0x7f000001);
    expect(parseIpLiteral('0')?.address).toBe('0.0.0.0');
    for (const s of ['256.1.1.1', '1.2.3.4.5', '08.1.1.1', '1..2', 'example.com', '4294967296', '']) expect(parseIpv4Loose(s), s).toBeNull();
  });

  it('reads IPv6 (compression, dotted tail, zone, brackets) and canonicalises it', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpLiteral('[0:0:0:0:0:0:0:1]')?.address).toBe('::1');
    expect(parseIpLiteral('FE80::1%en0')?.address).toBe('fe80::1');
    expect(parseIpLiteral('fd00:ec2:0::254')?.address).toBe('fd00:ec2::254');
    expect(parseIpLiteral('2001:db8::1')?.address).toBe('2001:db8::1');
    for (const s of ['1::2::3', '12345::1', '1:2:3:4:5:6:7:8:9', ':::', 'g::1']) expect(parseIpv6(s), s).toBeNull();
  });

  it('unwraps IPv4 embedded in IPv6: mapped, SIIT, compatible, NAT64', () => {
    for (const s of ['::ffff:169.254.169.254', '[::ffff:a9fe:a9fe]', '::ffff:0:a9fe:a9fe', '::169.254.169.254', '64:ff9b::a9fe:a9fe', '64:ff9b::169.254.169.254', '64:ff9b:1::a9fe:a9fe']) {
      expect(parseIpLiteral(s), s).toMatchObject({ family: 4, address: '169.254.169.254' });
    }
    expect(parseIpLiteral('::')).toMatchObject({ family: 6, address: '::' });
    expect(parseIpLiteral('::1')).toMatchObject({ family: 6, address: '::1' });
  });
});

describe('metadata and local ranges', () => {
  it('flags the metadata range in every spelling, and the metadata names', () => {
    for (const s of ['169.254.169.254', '2852039166', '[::ffff:a9fe:a9fe]', 'fd00:ec2::254', '64:ff9b::a9fe:a9fe', '169.254.1.2', '0xa9fea9fe']) {
      expect(isMetadataAddress(s), s).toBe(true);
    }
    for (const s of ['metadata.google.internal', 'METADATA.google.internal.', 'metadata']) expect(isMetadataName(s), s).toBe(true);
    expect(isMetadataHost('metadata.google.internal')).toBe(true);
    for (const s of ['10.0.0.1', '::1', 'example.com', 'metadata.example.com', '169.255.0.1']) expect(isMetadataHost(s), s).toBe(false);
  });

  it('classifies loopback, unspecified and link-local in every spelling', () => {
    expect(localAddressKind('127.0.0.1')).toBe('loopback');
    expect(localAddressKind('127.1')).toBe('loopback');
    expect(localAddressKind('2130706433')).toBe('loopback');
    expect(localAddressKind('::1')).toBe('loopback');
    expect(localAddressKind('::ffff:127.0.0.1')).toBe('loopback');
    expect(localAddressKind('0.0.0.0')).toBe('unspecified');
    expect(localAddressKind('::')).toBe('unspecified');
    expect(localAddressKind('169.254.10.1')).toBe('link-local');
    expect(localAddressKind('fe80::1%lo0')).toBe('link-local');
    expect(localAddressKind('febf::1')).toBe('link-local');
    for (const s of ['192.168.1.10', '10.0.0.1', 'fec0::1', '2001:db8::1', 'localhost']) expect(localAddressKind(s), s).toBeNull();
  });
});
