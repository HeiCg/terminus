import { streamUi } from '../ws.js';
import { buildEntryFilter } from '../filters.js';
import { entryRow, entryHeader, frameLine } from '../render.js';
import { line, type Ctx } from '../context.js';
import { flagString } from '../args.js';
import type { UiMessage, WsSummary } from '../../../collector/src/uiProtocol.js';

// Connect to /ui, print the last N entries from the snapshot, then follow live
// batches: one aligned line per HTTP entry and a `WS ↑/↓` line per frame. `--json`
// emits raw NDJSON of every event. Ctrl-C aborts the injected signal, which closes
// the socket cleanly and resolves.
export async function runTail(ctx: Ctx): Promise<number> {
  const filter = buildEntryFilter(ctx.flags);
  const lastStr = flagString(ctx.flags, 'last');
  const last = lastStr != null && Number.isFinite(Number(lastStr)) ? Number(lastStr) : 50;
  const deviceFilter = flagString(ctx.flags, 'device');
  const hostFilter = flagString(ctx.flags, 'host')?.toLowerCase();
  const pathFilter = flagString(ctx.flags, 'path')?.toLowerCase();
  const sessions = new Map<string, WsSummary>();
  let headerPrinted = false;

  const header = (): void => {
    if (!headerPrinted) { line(ctx, entryHeader(ctx.colors, ctx.columns)); headerPrinted = true; }
  };

  // A frame passes when it matches the device filter and, when a session is known,
  // the host/path substring filters — `--host` against the session URL's HOST only
  // (not the path) and `--path` against the path only, mirroring the entry filter.
  // Method/status filters do not apply to frames.
  const frameAllowed = (deviceId: string, session: WsSummary | undefined): boolean => {
    if (deviceFilter && deviceId !== deviceFilter) return false;
    if ((hostFilter || pathFilter) && session) {
      // A resumed session has no url yet; there is nothing to match a host/path
      // filter against, so it is filtered out when either is set.
      if (session.url == null) return false;
      let host: string; let pathAndQuery: string;
      try { const u = new URL(session.url); host = u.host.toLowerCase(); pathAndQuery = (u.pathname + u.search).toLowerCase(); }
      catch { host = session.url.toLowerCase(); pathAndQuery = session.url.toLowerCase(); }
      if (hostFilter && !host.includes(hostFilter)) return false;
      if (pathFilter && !pathAndQuery.includes(pathFilter)) return false;
    }
    return true;
  };

  const onMessage = (m: UiMessage): void => {
    if (ctx.json) { ctx.out(JSON.stringify(m) + '\n'); return; }
    switch (m.type) {
      case 'snapshot': {
        for (const s of m.ws.items) sessions.set(s.wsId, s);
        const items = m.entries.items.filter(filter).slice(-last);
        if (items.length) { header(); for (const e of items) line(ctx, entryRow(e, ctx.colors, ctx.columns)); }
        if (m.paused) line(ctx, ctx.colors.yellow('[paused — live deltas suppressed]'));
        break;
      }
      case 'entry':
        if (filter(m.entry)) { header(); line(ctx, entryRow(m.entry, ctx.colors, ctx.columns)); }
        break;
      case 'ws':
        sessions.set(m.session.wsId, m.session);
        break;
      case 'ws_frame': {
        const session = sessions.get(m.wsId);
        if (frameAllowed(m.deviceId, session)) {
          line(ctx, frameLine({ deviceId: m.deviceId, frame: m.frame }, session, ctx.colors, ctx.columns));
        }
        break;
      }
      case 'paused':
        line(ctx, m.paused ? ctx.colors.yellow('[paused]') : ctx.colors.dim('[resumed]'));
        break;
      case 'clear':
        line(ctx, ctx.colors.dim(m.deviceId ? `[cleared ${m.deviceId}]` : '[cleared]'));
        break;
      default:
        break;
    }
  };

  await streamUi(ctx.config, { onMessage, signal: ctx.signal });
  return 0;
}
