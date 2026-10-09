import dns from 'node:dns/promises';
import os from 'node:os';
import { isMetadataAddress, isMetadataName, localAddressKind, parseIpLiteral } from '../netAddr.js';

// The proxy's destination guard (0.3.0 review). A LAN device reaches the collector
// machine's own services through a raw stream, a TLS pass-through tunnel or SOCKS
// as if it were the machine itself unless the destination is checked BEFORE the
// dial. Refused:
//
//   always                 the cloud metadata range (169.254.0.0/16, fd00:ec2::254,
//                          and IPv4-mapped / NAT64 spellings of them) and the
//                          metadata names (`metadata.google.internal`, `metadata`)
//   unless allowLocal      loopback (127.0.0.0/8, ::1), unspecified (0.0.0.0/8, ::),
//                          link-local (fe80::/10; 169.254/16 is metadata above) and
//                          every address of the collector's own interfaces
//
// A hostname is resolved first and EVERY address it resolves to is checked; the
// caller then dials the checked address (`address`), so a second resolution cannot
// swap it (DNS rebinding). `TERMINUS_PROXY_ALLOW_LOCAL=1` sets allowLocal.

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

export type DestGuardOptions = {
  allowLocal: boolean;
  // DNS resolution (all addresses). Injectable for tests.
  lookup?: Lookup;
  // The collector's own addresses. Default: every interface address, read per check.
  ownAddresses?: () => Iterable<string>;
};

export type DestVerdict = { ok: true; address: string } | { ok: false; reason: string };

export type DestGuard = {
  // Resolve (when a name) and check `host`; the verdict carries the address to dial.
  check(host: string): Promise<DestVerdict>;
  // The synchronous part, for one IP literal or name: null when not refused by
  // itself (a name still needs `check`).
  refuseLiteral(host: string): string | null;
};

export const defaultLookup: Lookup = (host) => dns.lookup(host, { all: true, verbatim: true });

export function interfaceAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((nics) => (nics ?? []).map((n) => n.address));
}

export function createDestGuard(opts: DestGuardOptions): DestGuard {
  const lookup = opts.lookup ?? defaultLookup;
  const own = opts.ownAddresses ?? interfaceAddresses;

  const refuseAddress = (address: string): string | null => {
    if (isMetadataAddress(address)) return 'metadata range';
    if (opts.allowLocal) return null;
    const kind = localAddressKind(address);
    if (kind) return kind;
    const canon = parseIpLiteral(address)?.address;
    if (canon == null) return null;
    for (const a of own()) if (parseIpLiteral(a)?.address === canon) return "the collector's own address";
    return null;
  };

  const refuseLiteral = (host: string): string | null => {
    if (isMetadataName(host)) return 'metadata name';
    return parseIpLiteral(host) ? refuseAddress(host) : null;
  };

  return {
    refuseLiteral,
    async check(host) {
      const early = refuseLiteral(host);
      if (early) return { ok: false, reason: early };
      const lit = parseIpLiteral(host);
      if (lit) return { ok: true, address: lit.address };
      let addresses: string[];
      try { addresses = (await lookup(host)).map((a) => a.address); } catch (e) {
        return { ok: false, reason: `dns ${(e as NodeJS.ErrnoException).code ?? 'error'}` };
      }
      if (addresses.length === 0) return { ok: false, reason: 'dns ENOTFOUND' };
      for (const a of addresses) {
        const why = refuseAddress(a);
        if (why) return { ok: false, reason: `resolves to ${why}` };
      }
      return { ok: true, address: parseIpLiteral(addresses[0])?.address ?? addresses[0] };
    },
  };
}

// HTTP(S) and WebSocket passthrough dial through mockttp, which resolves the name
// itself and offers no hook to dial a checked address. This best-effort check
// resolves a NAME before the request is forwarded and reports whether any address
// is in the metadata range; results are cached for `ttlMs` (mockttp caches its
// own lookups for 10 s too). A resolution failure is not a refusal: the forward
// fails on its own. Residual gap: a name whose DNS answer changes between this
// lookup and mockttp's (rebinding) is not caught; raw streams and TLS tunnels have
// no such gap (they dial the checked address).
export function createMetadataResolver(lookup: Lookup = defaultLookup, ttlMs = 10_000): (host: string) => Promise<boolean> {
  // The promise is cached, so concurrent checks of one name share one lookup.
  const cache = new Map<string, { at: number; hit: Promise<boolean> }>();
  return (host) => {
    if (parseIpLiteral(host)) return Promise.resolve(isMetadataAddress(host));
    if (isMetadataName(host)) return Promise.resolve(true);
    const key = host.toLowerCase();
    const c = cache.get(key);
    if (c && Date.now() - c.at < ttlMs) return c.hit;
    const hit = lookup(host).then((as) => as.some((a) => isMetadataAddress(a.address)), () => false);
    if (cache.size >= 1000) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: Date.now(), hit });
    return hit;
  };
}
