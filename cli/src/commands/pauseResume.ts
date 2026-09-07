import { postJson } from '../http.js';
import { line, jsonLine, type Ctx } from '../context.js';

// Pause/resume the live UI stream. The collector exposes a single POST /api/pause
// taking { paused: bool } (there is no /api/resume route); pause sends true, resume
// sends false. A bearer CLI needs no Origin for the mutation.
async function setPaused(ctx: Ctx, paused: boolean): Promise<number> {
  const res = await postJson<{ paused: boolean }>(ctx.config, '/api/pause', { paused });
  if (ctx.json) { jsonLine(ctx, res); return 0; }
  line(ctx, res.paused ? ctx.colors.yellow('paused') : 'resumed');
  return 0;
}

export const runPause = (ctx: Ctx): Promise<number> => setPaused(ctx, true);
export const runResume = (ctx: Ctx): Promise<number> => setPaused(ctx, false);
