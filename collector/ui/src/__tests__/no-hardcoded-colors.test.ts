import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Colours in components/views/App must come from CSS custom properties (the
// design tokens in ui/src/lib/tokens.css), never from literals. tokens.css is
// the ONE place hex/rgb() are allowed to live, so it is outside the scanned set.
const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..'); // ui/src
const ROOTS = ['components', 'views'].map((d) => path.join(srcDir, d));

// Function/hex colour literals — unambiguous anywhere in the file (markup inline
// styles included). The `\b` after the hex digits stops a Svelte block opener
// like `{#each}` (→ `#eac`, 3 hex) from matching, since a letter follows.
const FUNC_COLOR =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|rgba?\(|hsla?\(|oklch\(|lab\(|hwb\(/;
// Named colours are only a violation in a VALUE position; the negative lookahead
// and value-only scan below keep `white-space` (a property name) from tripping.
const NAMED_COLOR = /\b(?:white|black)\b(?![-\w])/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.svelte$/.test(name)) out.push(full);
  }
  return out;
}

// Only the values (right of each `prop:`) of the <style> blocks, comments gone —
// so a property name such as `white-space` is never mistaken for a colour value.
function styleValues(src: string): string {
  const blocks = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  const noComments = blocks.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...noComments.matchAll(/:\s*([^;{}]+)/g)].map((m) => m[1]).join('\n');
}

const files = [...ROOTS.flatMap(walk), path.join(srcDir, 'App.svelte')];

describe('components/views/App carry no hardcoded colors (tokens only)', () => {
  for (const file of files) {
    it(`${path.relative(srcDir, file)}`, () => {
      const src = readFileSync(file, 'utf8');
      const fn = FUNC_COLOR.exec(src);
      expect(fn, fn ? `hardcoded color "${fn[0]}"` : '').toBeNull();
      const named = NAMED_COLOR.exec(styleValues(src));
      expect(named, named ? `named color "${named[0]}" as a value` : '').toBeNull();
    });
  }

  it('actually scanned some components', () => {
    expect(files.length).toBeGreaterThan(1);
  });
});
