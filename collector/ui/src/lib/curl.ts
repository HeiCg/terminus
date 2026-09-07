import type { Row } from './state/Filters.svelte.js';
import type { EntryDetail } from './protocol.js';

// Shell-single-quote a value: wrap in '…' and rewrite every embedded quote as the
// classic '\'' break-out-reopen sequence, so the emitted command is copy-paste
// safe even for URLs and bodies that contain quotes.
const q = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

// Reconstruct the request as a runnable `curl` invocation: the method and URL,
// one `-H` per request header (from the detail), and `--data-raw` when a request
// body is present. When the body was omitted (never fetched), a trailing comment
// records why instead of sending stale/empty data; when the body EXISTS but could
// not be loaded into the cache (transport failure, or evicted under memory
// pressure), `notLoadedBytes` records its size so the command never silently
// drops the payload. Returns '' with no row so the caller can render an empty
// state without a special case.
export function buildCurl(
  row: Pick<Row, 'method' | 'url'> | null,
  detail: EntryDetail | null,
  requestBody: string | null,
  omittedReason?: string,
  notLoadedBytes?: number | null,
): string {
  if (!row) return '';
  const lines = [`curl -X ${row.method.toUpperCase()} ${q(row.url)}`];
  for (const [k, v] of Object.entries(detail?.requestHeaders ?? {})) lines.push(`-H ${q(`${k}: ${v}`)}`);
  const hasBody = requestBody != null && requestBody.length > 0;
  if (hasBody) lines.push(`--data-raw ${q(requestBody)}`);
  let out = lines.join(' \\\n');
  if (!hasBody && omittedReason) out += `\n# request body omitted (${omittedReason})`;
  else if (!hasBody && notLoadedBytes != null && notLoadedBytes > 0) {
    out += `\n# request body (${notLoadedBytes} bytes) not loaded`;
  }
  return out;
}
