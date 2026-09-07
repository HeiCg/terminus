// Pure formatting helpers shared by the Foundations components and the views.
// Everything here is deterministic given its inputs (fmtTime/fmtRelative take an
// explicit clock) so it is trivially table-testable and safe to call in render.

const p2 = (n: number) => String(n).padStart(2, '0');
const p3 = (n: number) => String(n).padStart(3, '0');

// One shared encoder — the body cache and the tint cap both measure resident
// payloads in real UTF-8 bytes, never UTF-16 `string.length` (which under-counts
// every multibyte character and lets the 8 MiB budget drift).
const UTF8 = new TextEncoder();

/** UTF-8 byte length of a string (multibyte-aware), not UTF-16 code units. */
export const utf8Bytes = (s: string): number => UTF8.encode(s).byteLength;

/**
 * Decoded byte length of a base64 string, without allocating the bytes. Whitespace
 * is ignored; `=` padding is subtracted. Used to size a binary (base64-encoded)
 * body by its real bytes rather than the length of its base64 text.
 */
export const base64ByteLength = (b64: string): number => {
  const s = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  if (s.length === 0) return 0;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
};

/** Human byte size: `512 B`, `2.1 KB`, `1.0 MB`; `—` for null/undefined/NaN. */
export const fmtBytes = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
};

/** Duration: `142 ms` under a second, `1.2 s` at/above; `—` for null/undefined. */
export const fmtMs = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
};

/** Wall-clock time of day in local zone as `HH:mm:ss.SSS`. */
export const fmtTime = (epochMs: number): string => {
  const d = new Date(epochMs);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
};

/** Coarse "N s/min/h ago" relative to an explicit `now`; future clamps to 0 s. */
export const fmtRelative = (epochMs: number, now: number): string => {
  const s = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ago`;
};

/** Split a URL into `host` (with port) and `path` (pathname + query). */
export const splitUrl = (url: string): { host: string; path: string } => {
  try {
    const u = new URL(url);
    return { host: u.host, path: `${u.pathname}${u.search}` };
  } catch {
    return { host: '', path: url };
  }
};

export type StatusBucket = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'error' | 'pending';

/** Classify a response by status/error: error wins, null status is pending. */
export const statusBucket = (status: number | null, error: string | null): StatusBucket => {
  if (error) return 'error';
  if (status == null) return 'pending';
  switch (Math.floor(status / 100)) {
    case 1:
      // 1xx informational (notably 101 Switching Protocols on WS-upgrade rows) is
      // its own bucket so the `3xx` status chip never selects a 101 row; it still
      // borrows the blue `--status-3xx` tint (there is no dedicated 1xx colour).
      return '1xx';
    case 2:
      return '2xx';
    case 3:
      return '3xx';
    case 4:
      return '4xx';
    case 5:
      return '5xx';
    default:
      return 'error';
  }
};

export type DurationBucket = 'fast' | 'mid' | 'slow' | null;

/** Bucket a duration: <200ms fast, <1000ms mid, else slow; null passes through. */
export const durationBucket = (ms: number | null): DurationBucket => {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 200) return 'fast';
  if (ms < 1000) return 'mid';
  return 'slow';
};
