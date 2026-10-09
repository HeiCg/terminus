import { parseArgs, type Flags } from '../../cli/src/args.js';
import { resolveConnection, resolveToken, type Connection, type ResolvedToken, type TokenSource } from '../../cli/src/config.js';
import { ADMIN_TOKEN_FILE, READER_TOKEN_FILE, readTokenFile } from '../../collector/src/security/adminToken.js';

// How terminus-mcp finds the collector and its credential. The connection and token
// precedence is the CLI's own code (cli/src/config.ts): flags --host/--port/--token,
// then TERMINUS_HOST/TERMINUS_PORT/TERMINUS_TOKEN, then the token files in the
// collector's state dir. Unlike the CLI, the MCP server tries the read-only
// `reader-token` first and only then `admin-token`: an assistant reading traffic
// does not need the admin credential.

export const MCP_TOKEN_FILES = [READER_TOKEN_FILE, ADMIN_TOKEN_FILE] as const;

export type Settings = {
  conn: Connection;
  // Resolve the token now. Flags and env are fixed; a token file is re-read on
  // every call so a collector restart (new tokens) is picked up. Throws a CliError
  // ("no token: ...") when nothing is available.
  token: () => ResolvedToken;
  // Where the token came from at startup (null: none found yet). Never the token.
  startupSource: TokenSource | null;
  // True when the startup token is the admin token: read from the admin-token file,
  // or equal to its contents.
  isAdmin: boolean;
  // TERMINUS_MCP_ALLOW_REPLAY=1.
  replayOptIn: boolean;
  // terminus_replay is registered only with the admin token AND the opt-in.
  replayEnabled: boolean;
};

export type SettingsDeps = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  // Override the collector state dir (tests). Defaults to TERMINUS_STATE_DIR or the
  // platform default, exactly as the collector resolves it.
  stateDir?: string;
};

export function parseFlags(argv: string[]): Flags {
  return parseArgs(argv, { valueFlags: ['host', 'port', 'token'] }).flags;
}

// Throws (a CliError) only for an invalid port; a missing token is reported per
// tool call instead, so the server still starts and can explain the problem.
export function resolveSettings(deps: SettingsDeps): Settings {
  const flags = parseFlags(deps.argv);
  const base = { flags, env: deps.env, stateDir: deps.stateDir, tokenFiles: MCP_TOKEN_FILES };
  const conn = resolveConnection(base);
  const token = () => resolveToken(base);

  let startup: ResolvedToken | null = null;
  try { startup = token(); } catch { startup = null; }
  const adminFile = readTokenFile(ADMIN_TOKEN_FILE, deps.stateDir);
  const isAdmin = startup != null && (startup.source === ADMIN_TOKEN_FILE || (adminFile != null && startup.token === adminFile));
  const replayOptIn = deps.env.TERMINUS_MCP_ALLOW_REPLAY === '1';

  return {
    conn,
    token,
    startupSource: startup?.source ?? null,
    isAdmin,
    replayOptIn,
    replayEnabled: isAdmin && replayOptIn,
  };
}

// A one-line, token-free description of the configuration for the stderr log.
export function describeSettings(s: Settings): string {
  const cred = s.startupSource == null
    ? 'no token found yet (will retry on each call)'
    : `${s.isAdmin ? 'admin' : 'non-admin'} token from ${s.startupSource === 'flag' ? '--token' : s.startupSource === 'env' ? 'TERMINUS_TOKEN' : `the ${s.startupSource} file`}`;
  let replay = 'terminus_replay disabled';
  if (s.replayEnabled) replay = 'terminus_replay ENABLED (admin token + TERMINUS_MCP_ALLOW_REPLAY=1)';
  else if (s.replayOptIn) replay = 'terminus_replay disabled: TERMINUS_MCP_ALLOW_REPLAY=1 is set but the token is not the admin token';
  return `collector ${s.conn.baseUrl}; ${cred}; ${replay}`;
}
