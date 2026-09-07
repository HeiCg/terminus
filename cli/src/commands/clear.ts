import { postJson } from '../http.js';
import { line, jsonLine, type Ctx } from '../context.js';
import { flagString } from '../args.js';

// POST /api/clear, optionally scoped to one device via the query param. Returns
// { ok: true }. A bearer CLI needs no Origin for the mutation.
export async function runClear(ctx: Ctx): Promise<number> {
  const device = flagString(ctx.flags, 'device');
  const q = device ? `?device=${encodeURIComponent(device)}` : '';
  const res = await postJson<{ ok: boolean }>(ctx.config, '/api/clear' + q);
  if (ctx.json) { jsonLine(ctx, res); return 0; }
  line(ctx, device ? `cleared device ${device}` : 'cleared all capture data');
  return 0;
}
