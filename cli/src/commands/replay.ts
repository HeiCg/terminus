import { readFile } from 'node:fs/promises';
import { postJson } from '../http.js';
import { line, jsonLine, type Ctx } from '../context.js';
import { flagString, flagList, flagBool } from '../args.js';
import { generalError } from '../errors.js';
import { duration } from '../format.js';

// Parse `<deviceId>/<entryKey>` on the first slash (an entry key never starts one).
function parseTarget(target: string | undefined): { deviceId: string; id: string } {
  if (!target || !target.includes('/')) throw generalError('usage: terminus replay <deviceId>/<entryKey>');
  const i = target.indexOf('/');
  return { deviceId: target.slice(0, i), id: target.slice(i + 1) };
}

// `--header K:V` (repeatable) into a header map; the first colon splits name/value.
function parseHeaders(items: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of items) {
    const i = h.indexOf(':');
    if (i < 0) throw generalError(`invalid --header "${h}" (expected NAME:VALUE)`);
    out[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return out;
}

type ReplayResponse = { key: { deviceId: string; id: string }; status: number | null; durationMs: number; error: string | null; stripped: string[] };

// POST /api/replay: re-send a captured request (with optional overrides) from the
// collector's machine and print the outcome plus the new entry's key. --json emits
// the endpoint's raw response.
export async function runReplay(ctx: Ctx): Promise<number> {
  const { deviceId, id } = parseTarget(ctx.positionals[0]);

  const overrides: Record<string, unknown> = {};
  const method = flagString(ctx.flags, 'method');
  if (method !== undefined) overrides.method = method;
  const url = flagString(ctx.flags, 'url');
  if (url !== undefined) overrides.url = url;
  const headers = flagList(ctx.flags, 'header');
  if (headers.length) overrides.headers = parseHeaders(headers);

  const bodyStr = flagString(ctx.flags, 'body');
  const bodyFile = flagString(ctx.flags, 'body-file');
  if (bodyStr !== undefined && bodyFile !== undefined) throw generalError('pass only one of --body / --body-file');
  if (bodyStr !== undefined) overrides.body = bodyStr;
  else if (bodyFile !== undefined) {
    try { overrides.body = await readFile(bodyFile, 'utf8'); }
    catch { throw generalError(`cannot read --body-file ${bodyFile}`); }
  }

  // Credentials are stripped by default; --with-credentials re-sends them verbatim.
  const credentials = flagBool(ctx.flags, 'with-credentials') ? 'keep' : 'strip';

  const payload = { deviceId, id, credentials, ...(Object.keys(overrides).length ? { overrides } : {}) };
  const res = await postJson<ReplayResponse>(ctx.config, '/api/replay', payload);

  if (ctx.json) { jsonLine(ctx, res); return 0; }
  const c = ctx.colors;
  const outcome = res.error ? c.red(res.error) : String(res.status);
  line(ctx, `replayed ${deviceId}/${id} -> ${outcome} ${duration(res.durationMs)}`);
  line(ctx, `stored as ${res.key.deviceId}/${res.key.id}`);
  if (res.stripped?.length) line(ctx, `stripped: ${res.stripped.join(', ')}`);
  return 0;
}
