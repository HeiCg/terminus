import { readFileSync } from 'node:fs';

// The collector version, read once at module load from `collector/package.json` so
// there is a single source of truth (no hardcoded string to drift from the manifest).
// This module lives at `collector/src/version.ts` under tsx and compiles to
// `collector/dist/version.js`; in BOTH layouts package.json is exactly one directory
// up from the module, so a URL relative to `import.meta.url` resolves the same way in
// `tsx src/` and in `node dist/`.
function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    // A missing or unreadable manifest must never crash the boot; fall back to a
    // sentinel so /health and the banner still answer.
    return '0.0.0';
  }
}

export const VERSION: string = readVersion();
