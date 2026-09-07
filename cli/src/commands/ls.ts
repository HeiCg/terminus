import { getJson } from '../http.js';
import { buildEntryFilter } from '../filters.js';
import { entryRow, entryHeader } from '../render.js';
import { line, jsonLine, type Ctx } from '../context.js';
import { flagString, flagBool } from '../args.js';
import type { EntrySummary, Page } from '../../../collector/src/uiProtocol.js';

// GET /api/entries (paged). `--all` follows nextCursor to the end; `--limit N` caps
// the count (client-side after the shared filters apply). `--device` is sent to the
// API; the other filters are applied client-side over the returned page.
export async function runLs(ctx: Ctx): Promise<number> {
  const device = flagString(ctx.flags, 'device');
  const all = flagBool(ctx.flags, 'all');
  const limitStr = flagString(ctx.flags, 'limit');
  const limit = limitStr != null ? Number(limitStr) : undefined;
  const filter = buildEntryFilter(ctx.flags);

  const collected: EntrySummary[] = [];
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams();
    if (device) q.set('device', device);
    if (cursor) q.set('cursor', cursor);
    if (limit != null && Number.isFinite(limit) && !all) q.set('limit', String(limit));
    const qs = q.toString();
    const page: Page<EntrySummary> = await getJson(ctx.config, '/api/entries' + (qs ? `?${qs}` : ''));
    collected.push(...page.items);
    cursor = all ? page.nextCursor : null;
    if (!all) break; // one page (bounded by --limit) unless --all was asked
  } while (cursor);

  let rows = collected.filter(filter);
  if (limit != null && Number.isFinite(limit)) rows = rows.slice(0, limit);

  if (ctx.json) { jsonLine(ctx, rows); return 0; }
  if (rows.length === 0) { line(ctx, ctx.colors.dim('no entries')); return 0; }
  line(ctx, entryHeader(ctx.colors, ctx.columns));
  for (const e of rows) line(ctx, entryRow(e, ctx.colors, ctx.columns));
  return 0;
}
