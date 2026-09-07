import { log } from './log.js';

// Names already warned about, so the deprecation notice is emitted at most once
// per variable for the life of the process.
const warned = new Set<string>();

// Read a Terminus configuration variable by its bare NAME (without the `TERMINUS_`
// prefix). Prefers `TERMINUS_<name>`; when that is unset it falls back to the
// deprecated `NETCAPTURE_<name>` and warns once per name. An empty string counts
// as unset on both. Returns the value, or undefined when neither is set.
export function env(name: string): string | undefined {
  const preferred = process.env[`TERMINUS_${name}`];
  if (preferred != null && preferred !== '') return preferred;
  const legacy = process.env[`NETCAPTURE_${name}`];
  if (legacy != null && legacy !== '') {
    if (!warned.has(name)) {
      warned.add(name);
      log.warn(`NETCAPTURE_${name} is deprecated, use TERMINUS_${name}`);
    }
    return legacy;
  }
  return undefined;
}

// The variable spelling env() resolves for `name`, for use in error/log messages:
// the TERMINUS_ name when it is set (or when neither is), the deprecated
// NETCAPTURE_ name only when that is the one actually set.
export function envName(name: string): string {
  const legacy = process.env[`NETCAPTURE_${name}`];
  const preferred = process.env[`TERMINUS_${name}`];
  if ((preferred == null || preferred === '') && legacy != null && legacy !== '') return `NETCAPTURE_${name}`;
  return `TERMINUS_${name}`;
}
