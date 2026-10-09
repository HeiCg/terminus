import { parsePatternList, hostMatches, type HostPattern } from '../scope.js';
import { log } from '../log.js';

// User-configurable TLS interception for the proxy (U5). Two mutually exclusive
// modes on top of the default "MITM everything except the collector's own hosts":
//
//   pass-through    TERMINUS_PROXY_PASSTHROUGH: these hosts are tunnelled raw (no
//                   MITM, the device sees the real certificate, so pinned apps keep
//                   working); everything else is still intercepted.
//   intercept-only  TERMINUS_PROXY_INTERCEPT_ONLY: ONLY these hosts are intercepted;
//                   every other TLS connection is tunnelled raw.
//
// Patterns are host-only (`api.example.com`, `*.example.com`); see scope.ts. The
// collector's own hosts are always tunnelled and never intercepted, whatever the
// mode. A raw tunnel is recorded as a `CONNECT` entry with a `tunnel` field.
export type ProxyTlsConfig =
  | { mode: 'default' }
  | { mode: 'passthrough'; hosts: string[] }
  | { mode: 'intercept-only'; hosts: string[] };

// The address a passthrough pattern must never name: a raw tunnel there would hand
// a device the cloud metadata service (see CLOUD_METADATA_IP in server.ts).
const METADATA_HOST = '169.254.169.254';

// The mockttp hostname string for a parsed pattern (URLPattern syntax: a leading
// `*.` label is its wildcard too), normalized to lower case.
export const mockttpHostname = (p: HostPattern): string => (p.wildcard ? `*.${p.host}` : p.host);

export type ProxyTlsEnvNames = { passthrough: string; interceptOnly: string };

// Resolve the two env values into one mode. Invalid patterns are warned about and
// skipped. Throws (the caller refuses to start) when both are set, or when
// intercept-only is set but no usable pattern remains: silently intercepting
// nothing, or everything, would be the opposite of what was asked.
export function resolveProxyTls(
  raw: { passthrough?: string; interceptOnly?: string },
  collectorHosts: readonly string[],
  names: ProxyTlsEnvNames = { passthrough: 'TERMINUS_PROXY_PASSTHROUGH', interceptOnly: 'TERMINUS_PROXY_INTERCEPT_ONLY' },
): ProxyTlsConfig {
  const set = (v: string | undefined): v is string => v != null && v.trim() !== '';
  if (set(raw.passthrough) && set(raw.interceptOnly)) {
    throw new Error(`${names.passthrough} and ${names.interceptOnly} cannot both be set: pick pass-through (these hosts are not intercepted) or intercept-only (only these hosts are)`);
  }
  const usable = (value: string, name: string): HostPattern[] => {
    const r = parsePatternList(value, { allowPath: false });
    for (const i of r.invalid) log.warn(`${name}: ignoring invalid pattern "${i.raw}": ${i.message}`);
    return r.patterns.filter((p) => {
      if (hostMatches(p, METADATA_HOST)) { log.warn(`${name}: ignoring "${p.raw}": the cloud metadata address is never tunnelled`); return false; }
      return true;
    });
  };
  if (set(raw.passthrough)) {
    const hosts = usable(raw.passthrough, names.passthrough).map(mockttpHostname);
    return hosts.length ? { mode: 'passthrough', hosts: [...new Set(hosts)] } : { mode: 'default' };
  }
  if (set(raw.interceptOnly)) {
    const patterns = usable(raw.interceptOnly, names.interceptOnly).filter((p) => {
      const own = collectorHosts.find((h) => hostMatches(p, h));
      if (own) { log.warn(`${names.interceptOnly}: ignoring "${p.raw}": it matches the collector's own host ${own}, which is never intercepted`); return false; }
      return true;
    });
    if (patterns.length === 0) throw new Error(`${names.interceptOnly} has no usable host pattern; refusing to start rather than intercept nothing`);
    return { mode: 'intercept-only', hosts: [...new Set(patterns.map(mockttpHostname))] };
  }
  return { mode: 'default' };
}
