import { readTokenFile, ADMIN_TOKEN_FILE, READER_TOKEN_FILE, type TokenFile } from '../../collector/src/security/adminToken.js';
import { flagString, type Flags } from './args.js';
import { authError, generalError } from './errors.js';

// The resolved connection + credential the command layer talks through. `origin` is
// the loopback page Origin the collector's /ui WebSocket upgrade demands (it rejects
// a socket whose Origin is not a loopback host on its own port); HTTP calls need no
// Origin when they carry a bearer, but the socket does.
export type Config = {
  host: string;
  port: number;
  token: string;
  baseUrl: string;
  origin: string;
};

export type ResolveDeps = {
  flags: Flags;
  env: NodeJS.ProcessEnv;
  // Override the state dir the admin-token file is read from (tests). Defaults to
  // the collector's own resolver (TERMINUS_STATE_DIR or the platform default).
  stateDir?: string;
  // In `tail`/`ls`, `--host` is the traffic filter, not the connection host, so the
  // connection host comes from TERMINUS_HOST or the loopback default instead.
  hostIsFilter?: boolean;
  // The token files tried, in order, after --token and TERMINUS_TOKEN. CLI admin
  // commands keep the default (admin-token only); CLI read-only commands use
  // READ_ONLY_TOKEN_FILES; the MCP server prefers the read-only reader-token and
  // falls back to admin-token.
  tokenFiles?: readonly TokenFile[];
};

// The token files for CLI commands that only GET reader-scope routes (status, ls,
// show, devices): admin-token when present, else the read-only reader-token.
export const READ_ONLY_TOKEN_FILES: readonly TokenFile[] = [ADMIN_TOKEN_FILE, READER_TOKEN_FILE];

// Where a resolved token came from: a flag, the environment, or one of the token
// files a same-machine collector wrote.
export type TokenSource = 'flag' | 'env' | TokenFile;
export type ResolvedToken = { token: string; source: TokenSource };

// The connection half of a Config (no credential), shared with the MCP server.
export type Connection = Omit<Config, 'token'>;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

function resolvePort(flags: Flags, env: NodeJS.ProcessEnv): number {
  const raw = flagString(flags, 'port') ?? env.TERMINUS_PORT;
  if (raw == null || raw === '') return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw generalError(`invalid port: ${raw}`);
  }
  return n;
}

// Resolve the token in the spec's precedence order: --token, then TERMINUS_TOKEN,
// then each token file a same-machine collector wrote (admin-token by default),
// else a clear error.
export function resolveToken(deps: ResolveDeps): ResolvedToken {
  const flagTok = flagString(deps.flags, 'token');
  if (flagTok) return { token: flagTok, source: 'flag' };
  const envTok = deps.env.TERMINUS_TOKEN;
  if (envTok && envTok !== '') return { token: envTok, source: 'env' };
  for (const file of deps.tokenFiles ?? [ADMIN_TOKEN_FILE]) {
    const fileTok = readTokenFile(file, deps.stateDir);
    if (fileTok) return { token: fileTok, source: file };
  }
  throw authError('no token: pass --token, set TERMINUS_TOKEN, or run the collector on this machine');
}

export function resolveConnection(deps: ResolveDeps): Connection {
  const host = deps.hostIsFilter
    ? (deps.env.TERMINUS_HOST || DEFAULT_HOST)
    : (flagString(deps.flags, 'host') || deps.env.TERMINUS_HOST || DEFAULT_HOST);
  const port = resolvePort(deps.flags, deps.env);
  const baseUrl = `http://${host}:${port}`;
  return { host, port, baseUrl, origin: baseUrl };
}

export function resolveConfig(deps: ResolveDeps): Config {
  const conn = resolveConnection(deps);
  const { token } = resolveToken(deps);
  return { host: conn.host, port: conn.port, token, baseUrl: conn.baseUrl, origin: conn.origin };
}
