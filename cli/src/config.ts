import { readAdminTokenFile } from '../../collector/src/security/adminToken.js';
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
};

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
// then the admin-token file a same-machine collector wrote, else a clear error.
function resolveToken(deps: ResolveDeps): string {
  const flagTok = flagString(deps.flags, 'token');
  if (flagTok) return flagTok;
  const envTok = deps.env.TERMINUS_TOKEN;
  if (envTok && envTok !== '') return envTok;
  const fileTok = readAdminTokenFile(deps.stateDir);
  if (fileTok) return fileTok;
  throw authError('no token: pass --token, set TERMINUS_TOKEN, or run the collector on this machine');
}

export function resolveConfig(deps: ResolveDeps): Config {
  const host = deps.hostIsFilter
    ? (deps.env.TERMINUS_HOST || DEFAULT_HOST)
    : (flagString(deps.flags, 'host') || deps.env.TERMINUS_HOST || DEFAULT_HOST);
  const port = resolvePort(deps.flags, deps.env);
  const token = resolveToken(deps);
  const baseUrl = `http://${host}:${port}`;
  return { host, port, token, baseUrl, origin: baseUrl };
}
