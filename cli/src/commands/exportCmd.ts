import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getStream } from '../http.js';
import { errline, type Ctx } from '../context.js';
import { flagString, flagBool } from '../args.js';
import { generalError } from '../errors.js';

// GET /export.har (default) or /export.json, streamed to a file (`-o`) or stdout via
// stream.pipeline — never buffered whole, so a large capture does not sit in memory.
// `--device` scopes the export. The routes stream from an immutable snapshot, so a
// concurrent capture never corrupts the download.
export async function runExport(ctx: Ctx): Promise<number> {
  const asJson = flagBool(ctx.flags, 'json');
  const asHar = flagBool(ctx.flags, 'har');
  // Default to HAR; --json selects the JSON export.
  const kind = asJson && !asHar ? 'json' : 'har';
  const route = kind === 'har' ? '/export.har' : '/export.json';
  const device = flagString(ctx.flags, 'device');
  const q = device ? `?device=${encodeURIComponent(device)}` : '';

  const res = await getStream(ctx.config, route + q);
  if (!res.body) throw generalError(`${route} returned an empty response`);
  const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);

  const outfile = flagString(ctx.flags, 'o', 'output');
  if (outfile) {
    // Capture data may hold auth material, so the export file is owner-only (0600).
    await pipeline(source, fs.createWriteStream(outfile, { mode: 0o600 }));
    errline(ctx, `wrote ${kind.toUpperCase()} export to ${outfile}`);
  } else {
    // Stream chunks straight to stdout (via ctx.out so tests can capture) rather than
    // buffering the whole download; the sink adds nothing to the payload.
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) { ctx.out(chunk.toString('utf8')); cb(); },
    });
    await pipeline(source, sink);
  }
  return 0;
}
