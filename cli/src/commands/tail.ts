import { streamUi } from '../ws.js';
import { buildEntryFilter } from '../filters.js';
import { entryRow, entryHeader, frameLine } from '../render.js';
import { line, errline, type Ctx } from '../context.js';
import { flagString, flagBool } from '../args.js';
import { CliError } from '../errors.js';
import { entityKey, type UiMessage, type WsSummary, type EntrySummary } from '../../../collector/src/uiProtocol.js';

// Exponential backoff with full-ish jitter: 1s, 2s, 4s … capped at 15s, then a
// random 50–100% of that so a fleet of reconnecting clients does not thunder. The
// bounds are overridable via env purely so tests can drive fast reconnects.
function backoffMs(attempt: number, env: NodeJS.ProcessEnv): number {
  const min = Number(env.TERMINUS_RECONNECT_MIN_MS) || 1000;
  const cap = Number(env.TERMINUS_RECONNECT_MAX_MS) || 15000;
  const base = Math.min(cap, min * 2 ** (attempt - 1));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

// Sleep that resolves early (false) when the signal aborts, cleaning up its timer
// and listener either way; resolves true when the full delay elapses.
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = (): void => { clearTimeout(t); resolve(false); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(true); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Connect to /ui, print the last N entries from the snapshot, then follow live
// batches: one aligned line per HTTP entry and a `WS ↑/↓` line per frame. `--json`
// emits raw NDJSON of every event. Ctrl-C aborts the injected signal, which closes
// the socket cleanly and resolves. By default a connection the collector drops is
// retried with exponential backoff (announced on stderr, or a `{"event":"reconnect"}`
// line in --json); `--no-reconnect` restores the old exit-3-on-drop behaviour.
export async function runTail(ctx: Ctx): Promise<number> {
  const filter = buildEntryFilter(ctx.flags);
  const lastStr = flagString(ctx.flags, 'last');
  const last = lastStr != null && Number.isFinite(Number(lastStr)) ? Number(lastStr) : 50;
  const deviceFilter = flagString(ctx.flags, 'device');
  const hostFilter = flagString(ctx.flags, 'host')?.toLowerCase();
  const pathFilter = flagString(ctx.flags, 'path')?.toLowerCase();
  const reconnect = !flagBool(ctx.flags, 'no-reconnect');
  const sessions = new Map<string, WsSummary>();
  // Keys of every entry any snapshot has carried (shown or not), so a reconnect's
  // fresh snapshot reprints nothing already accounted for — only entries new since.
  const seenEntries = new Set<string>();
  let firstConnect = true;
  let headerPrinted = false;

  const header = (): void => {
    if (!headerPrinted) { line(ctx, entryHeader(ctx.colors, ctx.columns)); headerPrinted = true; }
  };

  const printEntry = (e: EntrySummary): void => {
    seenEntries.add(entityKey(e.deviceId, e.id));
    if (filter(e)) { header(); line(ctx, entryRow(e, ctx.colors, ctx.columns)); }
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
        if (firstConnect) {
          // First connect: the last N matching entries. Mark the rest of the window
          // seen too, so a later reconnect treats them as history, not new.
          const matching = m.entries.items.filter(filter);
          const shown = new Set(matching.slice(-last));
          for (const e of m.entries.items) { if (shown.has(e)) printEntry(e); else seenEntries.add(entityKey(e.deviceId, e.id)); }
          firstConnect = false;
        } else {
          // Reconnect: print only entries the previous connection never carried.
          for (const e of m.entries.items) if (!seenEntries.has(entityKey(e.deviceId, e.id))) printEntry(e);
        }
        if (m.paused) line(ctx, ctx.colors.yellow('[paused — live deltas suppressed]'));
        break;
      }
      case 'entry':
        printEntry(m.entry);
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

  // Announce a reconnection state. In --json we keep stdout a clean event stream and
  // emit a distinct `{"event":"reconnect"}` line; otherwise it goes to stderr so the
  // captured output stays parseable.
  const announce = (state: 'reconnecting' | 'reconnected', attempt: number, delayMs?: number): void => {
    if (ctx.json) { ctx.out(JSON.stringify({ event: 'reconnect', state, attempt, ...(delayMs != null ? { delayMs } : {}) }) + '\n'); return; }
    errline(ctx, state === 'reconnecting'
      ? ctx.colors.dim(`reconnecting… (attempt ${attempt}, retry in ${Math.round((delayMs ?? 0) / 100) / 10}s)`)
      : ctx.colors.dim('reconnected'));
  };

  let attempt = 0;
  let wasDropped = false;
  const onOpen = (): void => {
    if (wasDropped) { announce('reconnected', attempt); wasDropped = false; attempt = 0; }
  };

  for (;;) {
    try {
      await streamUi(ctx.config, { onMessage, onOpen, signal: ctx.signal });
      return 0; // clean stop: the user aborted (Ctrl-C) or a `--no-reconnect` never got here
    } catch (e) {
      // A clean abort that raced the socket close still exits 0.
      if (ctx.signal?.aborted) return 0;
      // Never loop: `--no-reconnect`, or a permanent auth failure (exit 2).
      if (!reconnect || (e instanceof CliError && e.code === 2)) throw e;
      attempt++;
      wasDropped = true;
      const delay = backoffMs(attempt, ctx.env);
      announce('reconnecting', attempt, delay);
      if (!(await sleep(delay, ctx.signal))) return 0; // aborted while waiting
    }
  }
}
