import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CollectorHarness } from '../../collector/test/fixtures/harness.js';
import type { Entry } from '../../collector/src/types.js';
import { resolveSettings, type Settings } from '../src/config.js';
import { createTerminusServer } from '../src/server.js';

// A fresh, empty collector state dir per test: settings must never fall back to the
// real user's state dir (and its live token files).
export function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-mcp-'));
}

// Settings pointing at a harness (or any host:port), with the given token in
// TERMINUS_TOKEN unless `token: null`.
export function settingsFor(
  target: CollectorHarness | { host: string; port: number },
  opts: { token?: string | null; env?: NodeJS.ProcessEnv; stateDir: string; argv?: string[] },
): Settings {
  let host: string; let port: string;
  if ('url' in target) { const u = new URL(target.url); host = u.hostname; port = u.port; }
  else { host = target.host; port = String(target.port); }
  const env: NodeJS.ProcessEnv = { TERMINUS_HOST: host, TERMINUS_PORT: port, ...opts.env };
  const token = opts.token === undefined && 'readerToken' in target ? target.readerToken : opts.token;
  if (token) env.TERMINUS_TOKEN = token;
  return resolveSettings({ argv: opts.argv ?? [], env, stateDir: opts.stateDir });
}

export type Connected = { client: Client; close: () => Promise<void> };

// Wire the server to an SDK client over the in-memory transport.
export async function connect(settings: Settings, log: (m: string) => void = () => {}): Promise<Connected> {
  const server = createTerminusServer(settings, { log });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'terminus-mcp-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

export async function call(c: Connected, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await c.client.callTool({ name, arguments: args })) as CallToolResult;
}

export function text(r: CallToolResult): string {
  return r.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

export async function toolNames(c: Connected): Promise<string[]> {
  return (await c.client.listTools()).tools.map((t) => t.name).sort();
}

// A complete Entry for the store, with request/response bodies by default.
export function makeEntry(over: Partial<Entry> = {}): Entry {
  return {
    id: 'r1', deviceId: 'd1', source: 'xhr', startedAt: Date.now(),
    method: 'POST', url: 'https://api.example.com/v1/items?q=1',
    requestHeaders: { 'content-type': 'application/json' }, requestBody: '{"a":1}',
    requestBodySize: 7, requestBodyOmitted: null,
    status: 201, statusText: 'Created', responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"ok":true}', responseBodySize: 11, responseBodyOmitted: null,
    durationMs: 42, error: null,
    ...over,
  };
}
