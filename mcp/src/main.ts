import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveSettings, describeSettings } from './config.js';
import { createTerminusServer } from './server.js';
import { VERSION } from './version.js';

// terminus-mcp entry: an MCP server on stdio. stdout carries the protocol, so every
// diagnostic goes to stderr, and no token is ever printed.

const log = (msg: string): void => { process.stderr.write(`[terminus-mcp] ${msg}\n`); };

const USAGE = `terminus-mcp ${VERSION}: MCP server (stdio) for a local Terminus collector

usage: terminus-mcp [--host <host>] [--port <port>] [--token <token>]

  --host, TERMINUS_HOST    collector host (default 127.0.0.1)
  --port, TERMINUS_PORT    collector port (default 8787)
  --token, TERMINUS_TOKEN  bearer; default: <stateDir>/reader-token, then admin-token
  TERMINUS_STATE_DIR       collector state dir override
  TERMINUS_MCP_ALLOW_REPLAY=1 with the admin token exposes terminus_replay
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { process.stderr.write(USAGE); return; }
  let settings;
  try {
    settings = resolveSettings({ argv, env: process.env });
  } catch (e) {
    log((e as Error).message);
    process.exitCode = 2;
    return;
  }
  log(`${VERSION} starting: ${describeSettings(settings)}`);
  const server = createTerminusServer(settings, { log });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  log(`fatal: ${(e as Error)?.stack ?? String(e)}`);
  process.exit(1);
});
