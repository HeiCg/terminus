import { firstSnapshot } from '../ws.js';
import { getJsonOr404, getJson } from '../http.js';
import { isScopeError } from '../errors.js';
import { line, jsonLine, type Ctx } from '../context.js';
import type { RetentionCounters } from '../../../collector/src/store.js';
import type { WorkStats } from '../../../collector/src/ingestScheduler.js';

// GET /api/status body: aggregate operational numbers, no capture payload. `ingest`
// is null when the collector was built without the shared ingest machinery.
type StatusBody = {
  version: string;
  uptimeMs: number;
  paused: boolean;
  devices: number;
  retention: RetentionCounters;
  bodies: { retainedBytes: number; blobCount: number; references: number };
  ingest: WorkStats | null;
};

// GET the live snapshot over the /ui socket, then GET the authenticated /api/status
// for the ingest/bodies counters the snapshot does not carry. Reports the paired
// devices, the live-window counts, pause state, protocol version and retention totals.
// The snapshot carries the newest window (not the full store size), so counts are
// labelled as the live window. An older collector without /api/status (404) still
// prints the snapshot; --json merges both objects as { snapshot, status }.
// P3: the /ui socket is admin-only, so a reader token gets a 403 there; status then
// reports from /api/status alone (`snapshot: null` in --json).
export async function runStatus(ctx: Ctx): Promise<number> {
  let snap: Awaited<ReturnType<typeof firstSnapshot>> | null;
  try { snap = await firstSnapshot(ctx.config); }
  catch (e) { if (!isScopeError(e)) throw e; snap = null; }
  if (!snap) {
    const status = await getJson<StatusBody>(ctx.config, '/api/status');
    if (ctx.json) { jsonLine(ctx, { snapshot: null, status }); return 0; }
    printStatusOnly(ctx, status);
    return 0;
  }
  const status = await getJsonOr404<StatusBody>(ctx.config, '/api/status');
  if (ctx.json) { jsonLine(ctx, { snapshot: snap, status }); return 0; }

  const c = ctx.colors;
  line(ctx, c.bold('Terminus collector'));
  if (status) line(ctx, `  version        v${status.version}`);
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
  if (status) printStatusSections(ctx, status);
  return 0;
}

// The bodies/ingest sections only /api/status carries.
function printStatusSections(ctx: Ctx, status: StatusBody): void {
  const c = ctx.colors;
  const b = status.bodies;
  line(ctx, `  bodies         ${b.retainedBytes} B retained, ${b.blobCount} blobs, ${b.references} refs`);
  if (status.ingest) {
    const i = status.ingest;
    line(ctx, c.bold('  ingest'));
    line(ctx, `    connections  ${i.connections}`);
    line(ctx, `    queued       ${i.queued} (${i.activeDecodes} decoding)`);
    line(ctx, `    applied      ${i.applied}, invalid ${i.invalid}`);
    line(ctx, `    back-pressure ${i.paused} paused now, ${i.pauses} pauses, ${i.overload} overload`);
    line(ctx, `    rejected auth ${i.rejectedDeviceAuth}`);
    line(ctx, `    budget used  ${i.budgetUsed} B`);
  }
}

// Reader-token view (P3): no live-window snapshot, so no entry/ws window counts;
// `devices` here is the connected-device count /api/status reports.
function printStatusOnly(ctx: Ctx, status: StatusBody): void {
  const c = ctx.colors;
  const r = status.retention;
  line(ctx, c.bold('Terminus collector'));
  line(ctx, `  version        v${status.version}`);
  line(ctx, `  devices        ${status.devices} connected`);
  line(ctx, `  paused         ${status.paused ? c.yellow('yes') : 'no'}`);
  line(ctx, `  retained       ${r.retainedBodyBytes} B bodies, ${r.retainedMetadataBytes} B metadata`);
  line(ctx, `  dropped        ${r.droppedEntries} entries, ${r.droppedSessions} sessions, ${r.droppedFrames} frames`);
  printStatusSections(ctx, status);
}
