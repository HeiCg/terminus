import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, parse } from 'node:path';

// The CLI's own version, read once from `cli/package.json`. The published layout
// nests the emitted tree (`dist/cli/src/version.js`) while the package.json sits at
// the package root, and under tsx/vitest this module is `cli/src/version.ts` with
// package.json one level up — the two are different relative distances, so we walk
// up from this module's directory to the nearest package.json instead of hardcoding
// a path. In both layouts the first package.json found on the way up is the CLI's.
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch { /* no package.json here (or unreadable) — keep walking up */ }
    if (dir === root) break;
    dir = dirname(dir);
  }
  return 'unknown';
}

export const VERSION = readVersion();
