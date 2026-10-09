import { postJson, getJsonOr404 } from '../http.js';
import { line, jsonLine, type Ctx } from '../context.js';
import { flagString, flagBool } from '../args.js';
import { generalError } from '../errors.js';
import { duration } from '../format.js';

type StreamReplayResponse = {
  key: { deviceId: string; wsId: string }; bytesSent: number; bytesReceived: number; durationMs: number;
  closedBy: 'server' | 'timeout' | 'cap' | 'error'; error: string | null; stored: boolean;
};

// `--frames 1,3,4`: frame sequences, as the Sockets view and /api/ws/…/frames show them.
function parseFrames(raw: string): number[] {
  const out: number[] = [];
  for (const tok of raw.split(',').map((t) => t.trim()).filter(Boolean)) {
    const n = Number(tok);
    if (!Number.isInteger(n) || n < 0) throw generalError(`invalid --frames "${raw}" (expected a comma-list of frame sequences, e.g. 1,3,4)`);
    out.push(n);
  }
  if (out.length === 0) throw generalError('--frames needs at least one frame sequence');
  return out;
}

// POST /api/replay/stream (U7): re-send a captured raw TCP/TLS stream's client
// frames on a fresh connection from the collector's machine and print the outcome
// plus the new session's key. --json emits the endpoint's raw response.
export async function runReplayStream(ctx: Ctx): Promise<number> {
  const [deviceId, wsId] = ctx.positionals;
  if (!deviceId || !wsId || ctx.positionals.length > 2) throw generalError('usage: terminus replay-stream <deviceId> <wsId> [--tls|--no-tls] [--sni host] [--frames 1,3,4] [--timeout ms]');

  const payload: Record<string, unknown> = { deviceId, wsId };
  const tlsOn = flagBool(ctx.flags, 'tls');
  const tlsOff = flagBool(ctx.flags, 'no-tls');
  if (tlsOn && tlsOff) throw generalError('pass only one of --tls / --no-tls');
  if (tlsOn) payload.tls = true;
  if (tlsOff) payload.tls = false;
  const sni = flagString(ctx.flags, 'sni');
  if (sni !== undefined) payload.sni = sni;
  const frames = flagString(ctx.flags, 'frames');
  if (frames !== undefined) payload.frames = parseFrames(frames);
  const timeout = flagString(ctx.flags, 'timeout');
  if (timeout !== undefined) {
    const n = Number(timeout);
    if (!Number.isInteger(n) || n < 1 || n > 30_000) throw generalError('--timeout must be an integer number of milliseconds, 1..30000');
    payload.timeoutMs = n;
  }

  // An older collector has no stream replay route; say so instead of a bare 404.
  const health = await getJsonOr404<{ capabilities?: string[] }>(ctx.config, '/health');
  if (!health?.capabilities?.includes('raw-streams')) {
    throw generalError('this collector does not support stream replay (capability raw-streams); upgrade it');
  }

  const res = await postJson<StreamReplayResponse>(ctx.config, '/api/replay/stream', payload);
  if (ctx.json) { jsonLine(ctx, res); return 0; }
  const c = ctx.colors;
  const how = res.closedBy === 'error' ? c.red(`error ${res.error ?? ''}`.trim()) : `closed by ${res.closedBy}`;
  line(ctx, `replayed ${deviceId} ${wsId} -> ${how}, sent ${res.bytesSent} B, received ${res.bytesReceived} B ${duration(res.durationMs)}`);
  line(ctx, res.stored ? `stored as ${res.key.deviceId} ${res.key.wsId}` : 'not stored (outside the capture scope)');
  return 0;
}
