import type { EntrySummary } from '../../collector/src/uiProtocol.js';
import { flagString, flagBool, type Flags } from './args.js';

// Match a status code against a token: `4xx`/`5xx`/`2xx`/`3xx` is a class, a bare
// number is exact. Unknown tokens never match.
function statusMatches(status: number | null, token: string): boolean {
  if (status == null) return false;
  const t = token.trim().toLowerCase();
  const cls = /^([1-5])xx$/.exec(t);
  if (cls) return Math.floor(status / 100) === Number(cls[1]);
  const n = Number(t);
  return Number.isInteger(n) && status === n;
}

function urlParts(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname + u.search };
  } catch {
    return { host: url, path: url };
  }
}

export type EntryFilter = (e: EntrySummary) => boolean;

// Build a client-side predicate from the shared `tail`/`ls` filter flags. Each flag
// narrows; an absent flag is a pass. `--device` is exact; `--method` is a
// comma-list; `--status` mixes classes and exact codes; `--host`/`--path` are
// case-insensitive substrings; `--errors` keeps transport errors and 4xx/5xx.
export function buildEntryFilter(flags: Flags): EntryFilter {
  const device = flagString(flags, 'device');
  const methods = flagString(flags, 'method')?.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean);
  const statuses = flagString(flags, 'status')?.split(',').map((s) => s.trim()).filter(Boolean);
  const host = flagString(flags, 'host')?.toLowerCase();
  const path = flagString(flags, 'path')?.toLowerCase();
  const errorsOnly = flagBool(flags, 'errors');

  return (e: EntrySummary): boolean => {
    if (device && e.deviceId !== device) return false;
    if (methods && methods.length && !methods.includes((e.method || '').toUpperCase())) return false;
    if (statuses && statuses.length && !statuses.some((t) => statusMatches(e.status, t))) return false;
    if (host || path) {
      const parts = urlParts(e.url);
      if (host && !parts.host.toLowerCase().includes(host)) return false;
      if (path && !parts.path.toLowerCase().includes(path)) return false;
    }
    if (errorsOnly && !(e.error != null || (e.status != null && e.status >= 400))) return false;
    return true;
  };
}
