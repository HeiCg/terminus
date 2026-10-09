import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { classifyInterface, lanAddresses, isIpv6LinkLocal } from '../src/security/interfaces.js';
import { pairingHost, loadOrCreateIdentity } from '../src/security/identity.js';
import { log } from '../src/log.js';

// The one interface classifier behind the certificate SAN, the proxy exclusion list
// and the pairing host. Every case runs against an injected fake
// os.networkInterfaces() so the test never depends on the machine's real NICs.

type Nic = os.NetworkInterfaceInfo;
function v4(address: string, internal = false): Nic {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` };
}
function v6(address: string, internal = false): Nic {
  return { address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal, cidr: `${address}/64`, scopeid: 0 };
}
const noEnv = () => undefined;
const envWith = (vars: Record<string, string>) => (name: string) => vars[name];

afterEach(() => { vi.restoreAllMocks(); });

describe('classifyInterface', () => {
  it('ranks Wi-Fi/Ethernet names as lan', () => {
    for (const n of ['en0', 'en7', 'eth0', 'wlan0', 'wlp3s0', 'wl0', 'enp0s31f6', 'eno1', 'ens33']) {
      expect(classifyInterface(n), n).toBe('lan');
    }
  });

  it('skips Linux virtual/tunnel interfaces', () => {
    for (const n of ['docker0', 'veth1a2b3c', 'br-0123abcd', 'virbr0', 'cni0', 'flannel.1', 'tun0', 'tap0']) {
      expect(classifyInterface(n), n).toBe('skip');
    }
  });

  it('skips macOS virtual/tunnel interfaces', () => {
    for (const n of ['utun0', 'utun3', 'awdl0', 'llw0', 'bridge100', 'anpi0', 'ap1']) {
      expect(classifyInterface(n), n).toBe('skip');
    }
  });

  it('keeps an unknown, non-virtual name as other (not skipped)', () => {
    expect(classifyInterface('bond0')).toBe('other');
    expect(classifyInterface('usb0')).toBe('other');
  });
});

describe('isIpv6LinkLocal', () => {
  it('matches fe80::/10 with or without a zone id', () => {
    expect(isIpv6LinkLocal('fe80::1')).toBe(true);
    expect(isIpv6LinkLocal('fe80::1%en0')).toBe(true);
    expect(isIpv6LinkLocal('FEBF::1')).toBe(true);
    expect(isIpv6LinkLocal('fec0::1')).toBe(false);
    expect(isIpv6LinkLocal('2001:db8::1')).toBe(false);
    expect(isIpv6LinkLocal('192.168.1.10')).toBe(false);
  });
});

describe('lanAddresses (SAN + proxy exclusion source)', () => {
  const linux = () => ({
    lo: [v4('127.0.0.1', true), v6('::1', true)],
    docker0: [v4('172.17.0.1')],
    'br-0123abcd': [v4('172.18.0.1')],
    veth9: [v6('fe80::a1')],
    virbr0: [v4('192.168.122.1')],
    'flannel.1': [v4('10.244.0.0')],
    tun0: [v4('10.8.0.2')],
    wlp3s0: [v4('192.168.1.20'), v6('fe80::20'), v6('2001:db8::20')],
    eth0: [v4('10.0.0.5')],
  });

  it('keeps loopback anchors and real LAN addresses, drops virtual NICs and fe80::', () => {
    const ips = lanAddresses(linux, noEnv);
    expect(ips).toEqual(expect.arrayContaining(['127.0.0.1', '::1', '192.168.1.20', '2001:db8::20', '10.0.0.5']));
    for (const bad of ['172.17.0.1', '172.18.0.1', '192.168.122.1', '10.244.0.0', '10.8.0.2', 'fe80::a1', 'fe80::20']) {
      expect(ips, bad).not.toContain(bad);
    }
  });

  it('drops macOS utun/awdl/llw/bridge/anpi/ap and link-local', () => {
    const ips = lanAddresses(() => ({
      lo0: [v4('127.0.0.1', true)],
      en0: [v6('fe80::1%en0'), v4('192.168.1.10')],
      utun3: [v4('100.64.0.2')],
      awdl0: [v6('fe80::aw')],
      llw0: [v6('fe80::ll')],
      bridge100: [v4('192.168.64.1')],
      anpi0: [v6('fe80::an')],
      ap1: [v6('fe80::ap')],
    }), noEnv);
    expect(ips).toContain('192.168.1.10');
    expect(ips).not.toContain('100.64.0.2');
    expect(ips).not.toContain('192.168.64.1');
    expect(ips.some((ip) => ip.toLowerCase().startsWith('fe80'))).toBe(false);
  });

  it('orders Wi-Fi/Ethernet addresses before other kept interfaces, loopback last', () => {
    const ips = lanAddresses(() => ({
      bond0: [v4('10.1.1.1')],
      lo: [v4('127.0.0.1', true)],
      en0: [v4('192.168.1.10')],
    }), noEnv);
    expect(ips).toEqual(['192.168.1.10', '10.1.1.1', '127.0.0.1', '::1']);
  });

  it('TERMINUS_SAN_INTERFACES uses the listed interfaces exclusively (even a virtual one), in list order', () => {
    const ips = lanAddresses(linux, envWith({ SAN_INTERFACES: 'docker0, eth0' }));
    expect(ips).toEqual(['172.17.0.1', '10.0.0.5', '127.0.0.1', '::1']);
  });

  it('TERMINUS_SAN_INTERFACES still drops IPv6 link-local and keeps the loopback anchors', () => {
    const ips = lanAddresses(linux, envWith({ SAN_INTERFACES: 'wlp3s0' }));
    expect(ips).toEqual(['192.168.1.20', '2001:db8::20', '127.0.0.1', '::1']);
  });

  it('TERMINUS_SAN_INTERFACES naming no present interface leaves the loopback anchors and warns', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const ips = lanAddresses(linux, envWith({ SAN_INTERFACES: 'nope9' }));
    expect(ips).toEqual(['127.0.0.1', '::1']);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('TERMINUS_SAN_INTERFACES');
  });

  it('a blank TERMINUS_SAN_INTERFACES is ignored', () => {
    expect(lanAddresses(linux, envWith({ SAN_INTERFACES: ' , ' }))).toEqual(lanAddresses(linux, noEnv));
  });
});

describe('pairingHost uses the classified order', () => {
  it('prefers the Wi-Fi/Ethernet IPv4 over docker0 and others, even when they enumerate first', async () => {
    // A cert whose SAN covers every candidate, so only the order decides.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-nic-'));
    try {
      const id = await loadOrCreateIdentity(dir, { host: 'localhost', ips: ['172.17.0.1', '10.1.1.1', '192.168.1.30'], keyBits: 2048 });
      const ifaces = () => ({ docker0: [v4('172.17.0.1')], bond0: [v4('10.1.1.1')], wlan0: [v4('192.168.1.30')] });
      expect(pairingHost(id, noEnv, () => lanAddresses(ifaces, noEnv))).toBe('192.168.1.30');
      // Without a Wi-Fi/Ethernet NIC the next kept interface wins; docker0 never does.
      const noWifi = () => ({ docker0: [v4('172.17.0.1')], bond0: [v4('10.1.1.1')] });
      expect(pairingHost(id, noEnv, () => lanAddresses(noWifi, noEnv))).toBe('10.1.1.1');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
