import { firstSnapshot } from '../ws.js';
import { line, jsonLine, type Ctx } from '../context.js';

// GET the live snapshot over the /ui socket, then close. Reports the paired devices,
// the live-window counts, pause state, protocol version and retention totals. The
// snapshot carries the newest window (not the full store size), so counts are
// labelled as the live window.
export async function runStatus(ctx: Ctx): Promise<number> {
  const snap = await firstSnapshot(ctx.config);
  if (ctx.json) { jsonLine(ctx, snap); return 0; }

  const c = ctx.colors;
  line(ctx, c.bold('Terminus collector'));
  line(ctx, `  devices        ${snap.devices.length}`);
  line(ctx, `  entries        ${snap.entries.items.length} (live window)${snap.truncated ? c.dim(' — snapshot truncated') : ''}`);
  line(ctx, `  ws sessions    ${snap.ws.items.length} (live window)`);
  line(ctx, `  paused         ${snap.paused ? c.yellow('yes') : 'no'}`);
  line(ctx, `  protocol       v${snap.protocolVersion ?? '?'}`);
  line(ctx, `  at capacity    ${snap.atMax ? c.yellow('yes') : 'no'}`);
  if (snap.retention) {
    const r = snap.retention;
    line(ctx, `  retained       ${r.retainedBodyBytes} B bodies, ${r.retainedMetadataBytes} B metadata`);
    line(ctx, `  dropped        ${r.droppedEntries} entries, ${r.droppedSessions} sessions, ${r.droppedFrames} frames`);
  }
  return 0;
}
