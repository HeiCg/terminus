import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Spec §0 forbids $effect / $effect.pre / $effect.root / legacy $: anywhere in
// ui/src (tests included). This walks the tree and asserts no source carries the
// banned syntax; the ESLint rule catches it at author time, this catches it in CI
// even if the lint step is skipped. The pattern matches this file's own mentions,
// so it excludes itself.
const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..'); // ui/src
const SELF = 'no-effect.test.ts';
const BANNED = /\$effect\b|^\s*\$:/m;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|svelte)$/.test(name)) out.push(full);
  }
  return out;
}

describe('ui/src is free of $effect and legacy $:', () => {
  for (const file of walk(srcDir)) {
    if (path.basename(file) === SELF) continue;
    it(`${path.relative(srcDir, file)}`, () => {
      expect(BANNED.test(readFileSync(file, 'utf8'))).toBe(false);
    });
  }
});
