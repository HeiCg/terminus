import os from 'node:os';
import { env, envName } from '../env.js';
import { log } from '../log.js';

// The one network-interface classifier behind the certificate SAN (new or rotated
// identities), the proxy's collector-endpoint exclusion list and the pairing host.
// Before it, every non-internal address went into all three, so a Linux docker0 or
// a macOS utun/awdl address could end up advertised as the pairing host.
//
// Rules, in order:
//   - internal (loopback) interfaces are skipped here; the loopback anchors
//     127.0.0.1 and ::1 are always appended (and sanArg() always adds them too);
//   - IPv6 link-local (fe80::/10) is skipped on every interface: it needs a zone id
//     a device cannot use, and it never belongs in a SAN;
//   - TERMINUS_SAN_INTERFACES (comma list of interface names) set: only those
//     interfaces are used, in the listed order, whatever their name;
//   - otherwise virtual/tunnel interfaces are skipped by name (VIRTUAL below),
//     Wi-Fi/Ethernet names (LAN below) come first and any other name follows.

export type InterfaceClass = 'lan' | 'other' | 'skip';
export type NetworkInterfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

const LOOPBACK_IPS = ['127.0.0.1', '::1'];

// Wi-Fi/Ethernet: macOS en*, Linux eth*, wlan*/wl* (wlp*), en* (enp*/eno*/ens*/enx*).
const LAN = /^(en|eth|wl)/;

// Virtual, container, VM and tunnel interfaces. Linux: docker/podman/bridge/veth,
// libvirt, CNI/flannel/calico/vxlan, VPN tun/tap/wg; macOS: utun (VPN, iCloud
// Private Relay), awdl/llw (AirDrop), bridge (Internet Sharing, VMs), anpi, ap
// (Personal Hotspot), gif/stf tunnels; VMware/VirtualBox host-only networks.
const VIRTUAL = /^(docker|podman|veth|br-|virbr|lxcbr|lxdbr|cni|flannel|cali|vxlan|tun|tap|wg|utun|awdl|llw|bridge|anpi|ap\d|gif|stf|vmnet|vboxnet)/;

export function classifyInterface(name: string): InterfaceClass {
  if (VIRTUAL.test(name)) return 'skip';
  if (LAN.test(name)) return 'lan';
  return 'other';
}

// fe80::/10: the first 10 bits are 1111 1110 10, i.e. fe80 through febf.
export function isIpv6LinkLocal(address: string): boolean {
  return /^fe[89ab][0-9a-f]:/i.test(address);
}

// The TERMINUS_SAN_INTERFACES list, or null when unset/blank.
function interfaceOverride(e: typeof env): string[] | null {
  const raw = e('SAN_INTERFACES');
  if (raw == null) return null;
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return names.length ? names : null;
}

function addressesOf(nics: os.NetworkInterfaceInfo[] | undefined): string[] {
  const out: string[] = [];
  for (const nic of nics ?? []) {
    if (nic.internal) continue;
    const ip = nic.address.replace(/%.*$/, '');
    if (isIpv6LinkLocal(ip)) continue;
    out.push(ip);
  }
  return out;
}

let overrideMissWarned = false;

// LAN IPv4/IPv6 the cert should be valid for, best candidate first, then the
// loopback anchors. `ifaces`/`e` are injectable so tests never read the machine's
// real interfaces or environment. The order matters: pairingHost() advertises the
// first LAN IPv4 in this list that the certificate SAN covers.
export function lanAddresses(ifaces: () => NetworkInterfaces = os.networkInterfaces, e: typeof env = env): string[] {
  const all = ifaces();
  const ordered: string[] = [];
  const only = interfaceOverride(e);
  if (only) {
    for (const name of only) ordered.push(...addressesOf(all[name]));
    if (ordered.length === 0 && !overrideMissWarned) {
      overrideMissWarned = true;
      log.warn(`${envName('SAN_INTERFACES')}=${JSON.stringify(only.join(','))} matches no interface with a usable address; only the loopback anchors are used`);
    }
  } else {
    const lan: string[] = [];
    const other: string[] = [];
    for (const [name, nics] of Object.entries(all)) {
      const cls = classifyInterface(name);
      if (cls === 'skip') continue;
      (cls === 'lan' ? lan : other).push(...addressesOf(nics));
    }
    ordered.push(...lan, ...other);
  }
  return [...new Set([...ordered, ...LOOPBACK_IPS])];
}
