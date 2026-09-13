import { getJson } from '../http.js';
import { buildEntryFilter } from '../filters.js';
import { entryRow, entryHeader } from '../render.js';
import { line, errline, jsonLine, type Ctx } from '../context.js';
import { flagString, flagBool } from '../args.js';
import type { EntrySummary, Page } from '../../../collector/src/uiProtocol.js';

// The client-side filter flags (everything but `--device`, which the API applies).
// When any is set, `/api/entries` returns matches mixed with non-matches, so a
// `--limit N` cannot be satisfied from one page — we must page through the store.
const CLIENT_FILTER_FLAGS = ['method', 'status', 'host', 'path', 'errors'] as const;

// GET /api/entries (paged, opaque cursor). `--device` is sent to the API; the other
// filters run client-side. Without a client filter the old behaviour holds: one page
// (bounded by `--limit`), or the whole store with `--all`. With a client filter and
// `--limit N`, page through the store until N matches are gathered or the store ends,
// capped so a rare filter never scans forever (a warning names the cap when hit).
export async function runLs(ctx: Ctx): Promise<number> {
  const device = flagString(ctx.flags, 'device');
  const all = flagBool(ctx.flags, 'all');
  const limitStr = flagString(ctx.flags, 'limit');
  const limit = limitStr != null && Number.isFinite(Number(limitStr)) ? Number(limitStr) : undefined;
  const filter = buildEntryFilter(ctx.flags);
  const hasClientFilter = CLIENT_FILTER_FLAGS.some((f) => ctx.flags[f] !== undefined);

  // Per-page fetch size and the page ceiling. Overridable via env for tests only.
  const pageSize = Number(ctx.env.TERMINUS_LS_PAGE_SIZE) || 200;
  const maxPages = Number(ctx.env.TERMINUS_LS_MAX_PAGES) || 50;

  const fetchPage = async (cursor: string | null, apiLimit?: number): Promise<Page<EntrySummary>> => {
    const q = new URLSearchParams();
    if (device) q.set('device', device);
    if (cursor) q.set('cursor', cursor);
    if (apiLimit != null) q.set('limit', String(apiLimit));
    const qs = q.toString();
    return getJson(ctx.config, '/api/entries' + (qs ? `?${qs}` : ''));
  };

  const matches: EntrySummary[] = [];
  let cursor: string | null = null;
  let capped = false;

  if (all) {
    // Follow every page to the end, keeping matches (a `--limit` still slices below).
    do {
      const page = await fetchPage(cursor);
      for (const e of page.items) if (filter(e)) matches.push(e);
      cursor = page.nextCursor;
    } while (cursor);
  } else if (hasClientFilter && limit != null) {
    // Page through the store until N matches or exhaustion, bounded by maxPages.
    let pages = 0;
    do {
      const page = await fetchPage(cursor, pageSize);
      for (const e of page.items) if (filter(e)) matches.push(e);
      cursor = page.nextCursor;
      if (matches.length >= limit) break;
      if (++pages >= maxPages) { capped = cursor != null; break; }
    } while (cursor);
  } else {
    // No client filter (or no limit): a single page, bounded by --limit when given.
    const page = await fetchPage(null, limit);
    for (const e of page.items) if (filter(e)) matches.push(e);
  }

  const rows = limit != null ? matches.slice(0, limit) : matches;

  if (capped && rows.length < (limit ?? 0)) {
    errline(ctx, ctx.colors.yellow(`stopped after ${maxPages} pages (~${maxPages * pageSize} entries scanned); results may be incomplete — narrow the filter or use --all`));
  }

  if (ctx.json) { jsonLine(ctx, rows); return 0; }
  if (rows.length === 0) { line(ctx, ctx.colors.dim('no entries')); return 0; }
  line(ctx, entryHeader(ctx.colors, ctx.columns));
  for (const e of rows) line(ctx, entryRow(e, ctx.colors, ctx.columns));
  return 0;
}
