import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const collectorDir = fileURLToPath(new URL('..', import.meta.url));
const scriptsDir = path.join(collectorDir, 'scripts');
const templatePath = path.join(scriptsDir, 'systemd', 'terminus-collector.service.template');

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
  COLLECTOR_DIR: '/home/x/terminus/collector',
  ENV_FILE: '/home/x/.config/terminus/collector.env',
});

describe('systemd --user unit template', () => {
  it('substitutes every placeholder and wires the expected paths', () => {
    expect(rendered).not.toMatch(/__[A-Z_]+__/);
    expect(rendered).toContain('ExecStart="/opt/node/bin/node" "/home/x/terminus/collector/dist/main.js"');
    expect(rendered).toContain('WorkingDirectory=/home/x/terminus/collector');
    expect(rendered).toContain('Environment="PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin"');
    // Optional env file: the '-' prefix keeps a missing file from failing the unit.
    expect(rendered).toContain('EnvironmentFile=-/home/x/.config/terminus/collector.env');
  });

  it('logs to journald, restarts on failure with a start limit, and starts at login', () => {
    expect(rendered).toMatch(/^StandardOutput=journal$/m);
    expect(rendered).toMatch(/^StandardError=journal$/m);
    expect(rendered).toMatch(/^Restart=on-failure$/m);
    expect(rendered).toMatch(/^RestartSec=\d+$/m);
    expect(rendered).toMatch(/^StartLimitBurst=\d+$/m);
    expect(rendered).toMatch(/^WantedBy=default\.target$/m);
  });
});

// Every service script must at least parse; CI runs the same `bash -n` check.
describe('service scripts parse', () => {
  const scripts = ['launchd/install.sh', 'launchd/uninstall.sh', 'systemd/install.sh', 'systemd/uninstall.sh'];
  for (const rel of scripts) {
    it(`bash -n ${rel}`, () => {
      const p = path.join(scriptsDir, rel);
      expect(() => execFileSync('bash', ['-n', p], { stdio: 'pipe' })).not.toThrow();
      expect(fs.statSync(p).mode & 0o111).not.toBe(0);
    });
  }
});
