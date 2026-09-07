import { getJson } from '../http.js';
import { deviceRow, deviceHeader } from '../render.js';
import { line, jsonLine, type Ctx } from '../context.js';
import type { UiDevice, Page } from '../../../collector/src/uiProtocol.js';

// GET /api/devices (paged). Columns are the fields the device DTO exposes: id,
// platform, app version, build profile, last seen, dropped count.
export async function runDevices(ctx: Ctx): Promise<number> {
  const collected: UiDevice[] = [];
  let cursor: string | null = null;
  do {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const page: Page<UiDevice> = await getJson(ctx.config, '/api/devices' + q);
    collected.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  if (ctx.json) { jsonLine(ctx, collected); return 0; }
  if (collected.length === 0) { line(ctx, ctx.colors.dim('no devices')); return 0; }
  line(ctx, deviceHeader(ctx.colors));
  for (const d of collected) line(ctx, deviceRow(d, ctx.colors));
  return 0;
}
