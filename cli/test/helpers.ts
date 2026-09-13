import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CollectorHarness } from '../../collector/test/fixtures/harness.js';
import type { Entry } from '../../collector/src/types.js';
import { PROTOCOL_VERSION } from '../../collector/src/uiProtocol.js';
import { main } from '../src/main.js';

export type RunResult = { code: number; stdout: string; stderr: string };

export type RunOptions = {
  // When given, TERMINUS_HOST/PORT/TOKEN are set from it so every command connects
  // to this collector. Pass `noToken: true` to omit the token (auth-precedence tests).
  harness?: CollectorHarness;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  signal?: AbortSignal;
  columns?: number;
  noToken?: boolean;
};

function envFor(opts: RunOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...opts.env };
  if (opts.harness) {
    const u = new URL(opts.harness.url);
    env.TERMINUS_HOST = u.hostname;
    env.TERMINUS_PORT = u.port;
    if (!opts.noToken) env.TERMINUS_TOKEN = opts.harness.adminToken;
  }
  return env;
}

// Start the CLI without awaiting completion, exposing live output buffers. Needed for
// `tail`, whose main() only resolves once its signal aborts.
export function startCli(argv: string[], opts: RunOptions = {}): { done: Promise<RunResult>; out: () => string; err: () => string } {
  const buf = { stdout: '', stderr: '' };
  const done = main(argv, {
    env: envFor(opts),
    stdout: { write: (s) => { buf.stdout += s; }, isTTY: false, columns: opts.columns ?? 120 },
    stderr: { write: (s) => { buf.stderr += s; } },
    stateDir: opts.stateDir,
    signal: opts.signal,
  }).then((code) => ({ code, stdout: buf.stdout, stderr: buf.stderr }));
  return { done, out: () => buf.stdout, err: () => buf.stderr };
}

// Drive the CLI in-process to completion, capturing stdout/stderr. Colour is forced
// off (isTTY false) so assertions match plain text.
export async function runCli(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  return startCli(argv, opts).done;
}

// Poll until `pred` is true or the timeout elapses (then throw).
export async function waitUntil(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

// A snapshot-message entry as it crosses the /ui socket. Only the fields the CLI
// renders (and the key) matter for these tests, so the rest are filled minimally.
export function snapshotEntry(over: { id: string; deviceId?: string; method?: string; url: string; status?: number | null }): Record<string, unknown> {
  const ref = { sha256: null, size: 0, omitted: null };
  return {
    id: over.id, deviceId: over.deviceId ?? 'd1', source: 'xhr', startedAt: Date.now(),
    method: over.method ?? 'GET', url: over.url, status: over.status ?? 200, durationMs: 10, error: null,
    requestBody: ref, responseBody: ref,
  };
}

// A `snapshot` UI message wrapping the given entries.
export function snapshotMessage(entries: Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: 'snapshot', devices: [],
    entries: { items: entries, nextCursor: null }, ws: { items: [], nextCursor: null },
    retention: null, atMax: false, truncated: false, paused: false, protocolVersion: PROTOCOL_VERSION,
  };
}

// A fake /ui WebSocket endpoint on an ephemeral loopback port. It accepts the CLI's
// upgrade (no auth check — tests set a token so config resolves) and lets the test
// script each connection: send the initial snapshot, push live frames, and drop the
// socket to simulate an unsolicited close so the CLI's reconnect path runs. `onOpen`
// receives the connection count (1 on first connect, 2 on the first reconnect, …).
export type FakeUiServer = {
  port: number;
  connections: () => number;
  send: (msg: unknown) => void;
  drop: () => void;
  close: () => Promise<void>;
};

export async function createFakeUiServer(onOpen: (n: number, sock: WebSocket) => void): Promise<FakeUiServer> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/ui' });
  let current: WebSocket | null = null;
  let count = 0;
  wss.on('connection', (sock) => { current = sock; count++; onOpen(count, sock); });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as { port: number }).port;
  return {
    port,
    connections: () => count,
    send: (msg) => current?.send(JSON.stringify(msg)),
    drop: () => current?.close(),
    close: () => new Promise<void>((r) => { wss.close(); http.close(() => r()); }),
  };
}

// A complete Entry for the store, with request/response bodies by default.
export function makeEntry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'r1', deviceId: 'd1', source: 'xhr', startedAt: Date.now(),
    method: 'POST', url: 'https://api.example.com/v1/items?q=1',
    requestHeaders: { 'content-type': 'application/json' }, requestBody: '{"a":1}',
    requestBodySize: 7, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":true}', responseBodySize: 11, responseBodyOmitted: null,
    durationMs: 42, error: null,
    ...over,
  };
}
