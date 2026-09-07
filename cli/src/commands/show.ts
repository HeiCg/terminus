import { getJson, getBody, type BodyResult } from '../http.js';
import { toCurl } from '../../../collector/src/curl.js';
import type { EntryDetail } from '../../../collector/src/uiProtocol.js';
import type { Entry } from '../../../collector/src/types.js';
import { line, jsonLine, type Ctx } from '../context.js';
import { flagString, flagBool } from '../args.js';
import { generalError } from '../errors.js';
import { hostPath } from '../render.js';
import { duration, clock } from '../format.js';

const enc = (s: string): string => encodeURIComponent(s);

// Parse `<deviceId>/<entryKey>` on the first slash (an entry key never starts one).
function parseTarget(target: string | undefined): { deviceId: string; id: string } {
  if (!target || !target.includes('/')) {
    throw generalError('usage: terminus show <deviceId>/<entryKey>');
  }
  const i = target.indexOf('/');
  return { deviceId: target.slice(0, i), id: target.slice(i + 1) };
}

function contentType(headers: Record<string, string>): string {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === 'content-type') return v.toLowerCase();
  return '';
}

// Turn a body route result into printable text: an omission marker, `<binary N
// bytes>` for octet-stream, pretty JSON when the entry declared JSON, else the text.
function renderBody(res: BodyResult, entryContentType: string): string {
  if (res.kind === 'missing') return '(no body)';
  if (res.kind === 'omitted') return `<omitted: ${res.reason}>`;
  if (res.contentType.includes('octet-stream')) return `<binary ${res.bytes.length} bytes>`;
  const text = Buffer.from(res.bytes).toString('utf8');
  if (text.length === 0) return '(empty)';
  if (entryContentType.includes('json')) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* fall through */ }
  }
  return text;
}

async function fetchBody(ctx: Ctx, deviceId: string, id: string, side: 'request' | 'response'): Promise<BodyResult> {
  return getBody(ctx.config, `/api/entries/${enc(deviceId)}/${enc(id)}/body?side=${side}`);
}

export async function runShow(ctx: Ctx): Promise<number> {
  const { deviceId, id } = parseTarget(ctx.positionals[0]);
  const detail = await getJson<EntryDetail>(ctx.config, `/api/entries/${enc(deviceId)}/${enc(id)}`);

  // --curl: emit the reproduction command and nothing else.
  if (flagBool(ctx.flags, 'curl')) {
    const req = await fetchBody(ctx, deviceId, id, 'request');
    const requestBody = req.kind === 'bytes' && !req.contentType.includes('octet-stream') && req.bytes.length
      ? Buffer.from(req.bytes).toString('utf8')
      : null;
    const entry = {
      method: detail.method, url: detail.url, requestHeaders: detail.requestHeaders, requestBody,
    } as unknown as Entry;
    line(ctx, toCurl(entry));
    return 0;
  }

  if (ctx.json) { jsonLine(ctx, detail); return 0; }

  const c = ctx.colors;
  line(ctx, `${c.bold(detail.method)} ${hostPath(detail.url)}`);
  line(ctx, c.dim(`  ${detail.url}`));
  line(ctx, `  status     ${detail.status ?? '-'} ${detail.statusText ?? ''}`.trimEnd());
  line(ctx, `  device     ${detail.deviceId}  (${detail.source})`);
  line(ctx, `  started    ${clock(detail.startedAt)}`);
  line(ctx, `  duration   ${duration(detail.durationMs)}`);
  if (detail.error) line(ctx, `  error      ${c.red(detail.error)}`);

  const bodyMode = (flagString(ctx.flags, 'body') ?? 'both').toLowerCase();
  const wantReq = bodyMode === 'request' || bodyMode === 'both';
  const wantRes = bodyMode === 'response' || bodyMode === 'both';

  line(ctx, '');
  line(ctx, c.bold('Request headers'));
  for (const [k, v] of Object.entries(detail.requestHeaders)) line(ctx, `  ${k}: ${v}`);
  if (wantReq) {
    const req = await fetchBody(ctx, deviceId, id, 'request');
    line(ctx, c.bold('Request body'));
    line(ctx, indent(renderBody(req, contentType(detail.requestHeaders))));
  }

  line(ctx, '');
  line(ctx, c.bold('Response headers'));
  for (const [k, v] of Object.entries(detail.responseHeaders)) line(ctx, `  ${k}: ${v}`);
  if (wantRes) {
    const res = await fetchBody(ctx, deviceId, id, 'response');
    line(ctx, c.bold('Response body'));
    line(ctx, indent(renderBody(res, contentType(detail.responseHeaders))));
  }
  return 0;
}

const indent = (s: string): string => s.split('\n').map((l) => '  ' + l).join('\n');
