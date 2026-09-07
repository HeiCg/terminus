import os from 'node:os';
import path from 'node:path';
import { env } from '../env.js';

// Where the persistent identity lives, per OS convention. Kept in its own module —
// with no crypto/cert/TLS imports — so the CLI can resolve the state dir (to find
// the admin-token file) without dragging identity.ts (and node:crypto/tls) into its
// bundle.
//
//   macOS   ~/Library/Application Support/Terminus
//   Windows %LOCALAPPDATA%\Terminus         (fallback ~/AppData/Local/Terminus)
//   Linux   $XDG_STATE_HOME/terminus         (fallback ~/.local/state/terminus)
//
// TERMINUS_STATE_DIR (or the deprecated NETCAPTURE_STATE_DIR) overrides all of them.
// `platform`/`environ` are injectable so the resolver is unit-testable per platform;
// production calls pass nothing and get process.platform/process.env. The override is
// read through env() only in the real-process case so the one-time NETCAPTURE_
// deprecation warning still fires.
export function defaultStateDir(
  platform: NodeJS.Platform = process.platform,
  environ: NodeJS.ProcessEnv = process.env,
): string {
  const override = environ === process.env
    ? env('STATE_DIR')
    : (environ.TERMINUS_STATE_DIR ?? environ.NETCAPTURE_STATE_DIR);
  if (override && override.trim() !== '') return path.resolve(override);

  const home = environ.HOME || environ.USERPROFILE || os.homedir();
  if (platform === 'win32') {
    const base = environ.LOCALAPPDATA && environ.LOCALAPPDATA.trim() !== ''
      ? environ.LOCALAPPDATA : path.join(home, 'AppData', 'Local');
    return path.join(base, 'Terminus');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Terminus');
  }
  const xdg = environ.XDG_STATE_HOME && environ.XDG_STATE_HOME.trim() !== ''
    ? environ.XDG_STATE_HOME : path.join(home, '.local', 'state');
  return path.join(xdg, 'terminus');
}
