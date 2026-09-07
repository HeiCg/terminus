import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The mandated 16% tint surface must live in exactly one place AND actually
// resolve at runtime. It resolves only if declared on a selector that matches
// the consuming element (so `var(--tint)` substitutes against that element's own
// --tint) — `*`, not `:root`, where --tint is undefined. jsdom can't compute
// custom-property substitution, so this guards the contract statically.
const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..'); // ui/src
const globalCss = readFileSync(path.join(srcDir, 'lib', 'global.css'), 'utf8');
const componentsDir = path.join(srcDir, 'components');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.svelte$/.test(name)) out.push(full);
  }
  return out;
}

describe('tint surface contract', () => {
  it('global.css declares --tint-surface (16%) under a `*` selector', () => {
    const rule = /\*\s*\{[^}]*--tint-surface\s*:\s*color-mix\(in srgb, var\(--tint\) 16%, transparent\)/;
    expect(rule.test(globalCss)).toBe(true);
  });

  it('does NOT declare --tint-surface under :root (would resolve --tint as undefined)', () => {
    const rootRule = /:root\s*\{[^}]*--tint-surface/;
    expect(rootRule.test(globalCss)).toBe(false);
  });

  it('every component that reads --tint-surface also sets --tint in the same file', () => {
    const offenders = walk(componentsDir).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return src.includes('var(--tint-surface)') && !src.includes('--tint:');
    });
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });
});
