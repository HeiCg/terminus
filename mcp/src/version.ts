import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, parse } from 'node:path';

// The server's own version, read from `mcp/package.json`. As in the CLI, the emitted
// tree is nested (`dist/mcp/src/version.js`) while vitest runs `mcp/src/version.ts`,
// so walk up to the nearest package.json named @terminus/mcp instead of hardcoding a
// relative path.
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      if (pkg.name === '@terminus/mcp' && typeof pkg.version === 'string') return pkg.version;
    } catch { /* no package.json here (or unreadable): keep walking up */ }
    if (dir === root) break;
    dir = dirname(dir);
  }
  return 'unknown';
}

export const VERSION = readVersion();
