import type { EntrySummary, WsSummary, FrameSummary, UiDevice } from '../../collector/src/uiProtocol.js';
import { cell, truncate, clock, duration, type Colors } from './format.js';

// Column widths shared by `tail` and `ls` so their output lines up. The final
// host+path column flexes to the terminal width.
const W = { time: 8, device: 14, method: 6, status: 4, dur: 7 } as const;
const GAP = ' ';
const FIXED = W.time + W.device + W.method + W.status + W.dur + GAP.length * 5;

// Colour a status code by class: 2xx green, 3xx blue, 4xx yellow, 5xx red. A null
// status (in flight / errored) shows a dim dash.
export function statusText(status: number | null, colors: Colors): string {
  if (status == null) return colors.dim(cell('-', W.status, 'right'));
  const s = cell(String(status), W.status, 'right');
  if (status >= 500) return colors.red(s);
  if (status >= 400) return colors.yellow(s);
  if (status >= 300) return colors.blue(s);
  if (status >= 200) return colors.green(s);
  return s;
}

// The host+path shown in the flexible last column, from the entry URL. Falls back to
// the raw URL when it does not parse.
export function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname + u.search;
  } catch {
    return url;
  }
}

// One HTTP entry as a single aligned line. `columns` is the terminal width; the
// host+path column takes whatever is left after the fixed columns (min 12).
export function entryRow(e: EntrySummary, colors: Colors, columns: number): string {
  const rest = Math.max(12, columns - FIXED);
  const time = colors.dim(cell(clock(e.startedAt), W.time));
  const device = colors.gray(cell(e.deviceId, W.device));
  const method = cell(e.method, W.method);
  const status = statusText(e.status, colors);
  const dur = cell(duration(e.durationMs), W.dur, 'right');
  const target = e.error ? colors.red(truncate(`${hostPath(e.url)}  ! ${e.error}`, rest)) : truncate(hostPath(e.url), rest);
  return [time, device, method, status, dur, target].join(GAP);
}

// A WebSocket/SSE frame line for the live tail: `WS ↑`/`WS ↓` by direction, the
// time, device, and the session URL host+path.
export function frameLine(
  ev: { deviceId: string; frame: FrameSummary },
  session: WsSummary | undefined,
  colors: Colors,
  columns: number,
): string {
  const arrow = ev.frame.direction === 'out' ? '↑' : '↓';
  const tag = colors.blue(cell(`WS ${arrow}`, W.time));
  const device = colors.gray(cell(ev.deviceId, W.device));
  const kind = cell(ev.frame.binary ? 'bin' : 'text', W.method);
  const seq = cell(`#${ev.frame.sequence}`, W.status + 1 + W.dur, 'right');
  const rest = Math.max(12, columns - (W.time + W.device + W.method + W.status + 1 + W.dur + GAP.length * 4));
  const where = session ? truncate(hostPath(session.url), rest) : '';
  return [tag, device, kind, seq, where].join(GAP);
}

// A device row for `terminus devices`. The collector's device DTO carries no
// friendly name or per-device entry count, so the columns are the fields it does
// expose: id, platform, app version, build profile, last-seen time, dropped count.
const DW = { id: 22, platform: 10, appVersion: 14, build: 12, seen: 8 } as const;

export function deviceHeader(colors: Colors): string {
  return colors.dim([
    cell('DEVICE', DW.id), cell('PLATFORM', DW.platform), cell('APP', DW.appVersion),
    cell('BUILD', DW.build), cell('LAST SEEN', DW.seen), 'DROPPED',
  ].join(GAP));
}

export function deviceRow(d: UiDevice, colors: Colors): string {
  return [
    cell(d.deviceId, DW.id), cell(d.platform ?? '', DW.platform), cell(d.appVersion ?? '', DW.appVersion),
    cell(d.buildProfile ?? '', DW.build), colors.dim(cell(clock(d.lastSeen), DW.seen)),
    String(d.dropped ?? 0),
  ].join(GAP);
}

export function entryHeader(colors: Colors, columns: number): string {
  const rest = Math.max(12, columns - FIXED);
  return colors.dim([
    cell('TIME', W.time), cell('DEVICE', W.device), cell('METHOD', W.method),
    cell('CODE', W.status, 'right'), cell('DUR', W.dur, 'right'), truncate('HOST/PATH', rest),
  ].join(GAP));
}
