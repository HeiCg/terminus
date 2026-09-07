// Regenerate the committed HAR fixtures under test/fixtures/har/ from the single
// source of truth in test/fixtures/har/scenarios.ts. It renders each scenario
// through the real exporter (writeHar) and writes the pretty-printed HAR — exactly
// what test/har-roundtrip.test.ts renders and diffs against, so the committed
// artifacts never drift from the exporter.
//
// Run with: npx tsx scripts/regen-har-fixtures.ts
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios, renderHar } from '../test/fixtures/har/scenarios.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'test', 'fixtures', 'har');

async function main(): Promise<void> {
  for (const sc of scenarios) {
    const har = await renderHar(sc.build());
    const file = path.join(outDir, sc.file);
    writeFileSync(file, JSON.stringify(har, null, 2) + '\n');
    process.stdout.write(`wrote ${path.relative(path.resolve(here, '..'), file)}\n`);
  }
}

void main();
