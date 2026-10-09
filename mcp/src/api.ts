import type { Connection } from '../../cli/src/config.js';

// The HTTP side of the MCP server: one bearer-authenticated fetch per call against
// the collector's read API (docs/read-api.md), with every failure turned into a
// ToolError whose message tells the model what happened and what to do next. A
// ToolError becomes an `isError: true` tool result; nothing here crashes the server.

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export const TOO_OLD = 'Terminus collector too old: needs 0.2.0+';

export type Health = { status?: string; version?: string; apiVersion?: number; capabilities?: string[] };

export type BodyResult =
  | { kind: 'missing' }
  | { kind: 'omitted'; reason: string; size: number | null }
  | { kind: 'bytes'; contentType: string; bytes: Uint8Array };

// Statuses a caller handles itself instead of having request() throw.
type Allow = readonly number[];

async function readJsonBody(res: Response): Promise<any> {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text); } catch { return text.trim() ? { text: text.trim() } : null; }
}

export class TerminusApi {
  private health: Health | null = null;

  // `token` is called on every request: a token read from the collector's state
  // dir is re-read each time, so a collector restart (which rotates the tokens)
  // does not leave the server holding a dead credential.
  constructor(readonly conn: Connection, private readonly token: () => string) {}

  private unreachable(): ToolError {
    return new ToolError(
      `cannot reach the Terminus collector at ${this.conn.host}:${this.conn.port}. Is it running (npm start in collector/)? `
      + 'Set TERMINUS_HOST / TERMINUS_PORT if it listens elsewhere.',
    );
  }

  private bearer(): string {
    try { return this.token(); } catch (e) {
      throw new ToolError(`${(e as Error).message}. terminus-mcp reads <stateDir>/reader-token (then admin-token) from the collector's state directory, or TERMINUS_TOKEN.`);
    }
  }

  // One authenticated request. 2xx and the `allow`ed statuses come back as the
  // Response; every other status is mapped to a ToolError here.
  async request(method: string, pathAndQuery: string, opts: { body?: unknown; signal?: AbortSignal; allow?: Allow } = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.bearer()}` };
    const init: RequestInit = { method, headers, signal: opts.signal };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await fetch(this.conn.baseUrl + pathAndQuery, init);
    } catch {
      if (opts.signal?.aborted) throw new ToolError('request cancelled');
      // The collector went away (or never was): forget its /health so a restarted
      // or upgraded collector is checked again.
      this.health = null;
      throw this.unreachable();
    }
    if ((res.status >= 200 && res.status < 300) || opts.allow?.includes(res.status)) return res;
    throw await this.mapError(res, method, pathAndQuery);
  }

  private async mapError(res: Response, method: string, pathAndQuery: string): Promise<ToolError> {
    const body = await readJsonBody(res);
    const route = pathAndQuery.split('?')[0];
    switch (res.status) {
      case 400:
        return new ToolError(`bad request (400) on ${route}: ${body?.message ?? body?.text ?? 'malformed parameter'}`);
      case 401:
        return new ToolError(
          'authentication failed (401): the token is wrong or from before a collector restart (tokens rotate on every start). '
          + 'If you set TERMINUS_TOKEN, update it from <stateDir>/reader-token; a token read from the state dir is re-read on the next call.',
        );
      case 403:
        if (body?.error === 'forbidden_scope') {
          return new ToolError(`forbidden (403 forbidden_scope): ${method} ${route} needs the admin token, and the configured token is the read-only reader token.`);
        }
        return new ToolError(`forbidden (403) on ${route}: ${body?.text ?? body?.error ?? 'refused'}`);
      case 404:
        return new ToolError(`not found (404): ${route}. The record may have been evicted or cleared, or the ids are wrong.`);
      case 409:
        if (body?.error === 'stale_cursor') {
          return new ToolError(
            `stale cursor (409 stale_cursor): the collector restarted or afterSeq is ahead of it (current epoch ${body.epoch}, lastSeq ${body.lastSeq}). `
            + 'Call terminus_status and start again from its epoch and lastSeq; entries from before a restart are gone.',
          );
        }
        return new ToolError(`conflict (409) on ${route}`);
      case 429:
        return new ToolError(
          `too many pending waits on the collector (429${body?.limit != null ? `, limit ${body.limit}` : ''}). `
          + 'Retry shortly, or use terminus_entries with afterSeq instead of waiting.',
        );
      default: {
        const detail = body?.error ?? body?.text;
        return new ToolError(`${method} ${route} -> ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
      }
    }
  }

  async getJson<T = any>(pathAndQuery: string, signal?: AbortSignal): Promise<T> {
    const res = await this.request('GET', pathAndQuery, { signal });
    return (await res.json()) as T;
  }

  async postJson<T = any>(pathAndQuery: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.request('POST', pathAndQuery, { body, signal });
    const text = (await res.text()).trim();
    return (text ? JSON.parse(text) : {}) as T;
  }

  // One body route (entry body or frame body): 404 is `missing`, 410 `omitted`
  // with the reason, else the stored bytes.
  async getBody(pathAndQuery: string, signal?: AbortSignal): Promise<BodyResult> {
    const res = await this.request('GET', pathAndQuery, { signal, allow: [404, 410] });
    if (res.status === 404) { await res.arrayBuffer().catch(() => undefined); return { kind: 'missing' }; }
    if (res.status === 410) {
      const body = await readJsonBody(res);
      return { kind: 'omitted', reason: res.headers.get('x-body-omitted') ?? body?.omitted ?? 'unknown', size: typeof body?.size === 'number' ? body.size : null };
    }
    return { kind: 'bytes', contentType: res.headers.get('content-type') ?? 'application/octet-stream', bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  // Feature detection (read-api.md "Versioning"): GET /health once, anonymously,
  // and refuse to work against a collector without apiVersion >= 1. A success is
  // cached until the collector stops answering; a failure is re-checked next call.
  async ensureCompatible(required: readonly string[] = [], signal?: AbortSignal): Promise<Health> {
    if (!this.health) {
      let res: Response;
      try {
        res = await fetch(`${this.conn.baseUrl}/health`, { signal });
      } catch {
        if (signal?.aborted) throw new ToolError('request cancelled');
        throw this.unreachable();
      }
      const body = res.ok ? await readJsonBody(res) : null;
      if (!body || typeof body.apiVersion !== 'number' || body.apiVersion < 1) throw new ToolError(TOO_OLD);
      this.health = body as Health;
    }
    const caps = this.health.capabilities ?? [];
    const missing = required.filter((c) => !caps.includes(c));
    if (missing.length) {
      throw new ToolError(
        `the collector at ${this.conn.host}:${this.conn.port} (version ${this.health.version ?? '?'}) lacks the capability ${missing.map((m) => `"${m}"`).join(', ')}; upgrade the collector.`,
      );
    }
    return this.health;
  }
}

// Build a query string from the defined parameters (undefined and '' are skipped).
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const enc = encodeURIComponent;
