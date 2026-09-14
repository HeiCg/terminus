import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const collectorDir = fileURLToPath(new URL('..', import.meta.url));
const templatePath = path.join(collectorDir, 'scripts', 'launchd', 'com.terminus.collector.plist.template');

// Same placeholder substitution install.sh performs, so the test exercises the real
// template that ships.
function render(vars: Record<string, string>): string {
  let s = fs.readFileSync(templatePath, 'utf8');
  for (const [k, v] of Object.entries(vars)) s = s.split(`__${k}__`).join(v);
  return s;
}

const rendered = render({
  NODE: '/opt/node/bin/node',
  NODE_DIR: '/opt/node/bin',
  COLLECTOR_DIR: '/Users/x/terminus/collector',
  LOG_DIR: '/Users/x/Library/Logs/Terminus',
});

const hasPlutil = (() => { try { execFileSync('which', ['plutil']); return true; } catch { return false; } })();

describe('launchd plist template (T5.6)', () => {
  it('substitutes every placeholder and wires the expected paths', () => {
    expect(rendered).not.toMatch(/__[A-Z_]+__/);
    expect(rendered).toContain('<string>com.terminus.collector</string>');
    expect(rendered).toContain('<string>/opt/node/bin/node</string>');
    expect(rendered).toContain('<string>/Users/x/terminus/collector/dist/main.js</string>');
    expect(rendered).toContain('<string>/Users/x/Library/Logs/Terminus/collector.log</string>');
  });

  // plutil is macOS-only; a non-macOS CI runner skips this with a stated reason.
  it.skipIf(!hasPlutil)('renders a plist that passes plutil -lint (skipped when plutil absent: non-macOS)', () => {
    const tmp = path.join(os.tmpdir(), `terminus-plist-${process.pid}-${Date.now()}.plist`);
    fs.writeFileSync(tmp, rendered);
    try {
      const out = execFileSync('plutil', ['-lint', tmp]).toString();
      expect(out).toContain('OK');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
