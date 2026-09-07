import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { defaultStateDir } from '../src/security/stateDir.js';

// The resolver takes an injected platform + env so we can pin each OS without
// touching the real machine. `path.join` builds the expected value so the test is
// separator-agnostic (Windows joins with the host separator here).
describe('defaultStateDir per platform', () => {
  it('macOS → ~/Library/Application Support/Terminus', () => {
    const dir = defaultStateDir('darwin', { HOME: '/Users/dev' });
    expect(dir).toBe(path.join('/Users/dev', 'Library', 'Application Support', 'Terminus'));
  });

  it('Linux → $XDG_STATE_HOME/terminus, else ~/.local/state/terminus', () => {
    expect(defaultStateDir('linux', { HOME: '/home/dev' }))
      .toBe(path.join('/home/dev', '.local', 'state', 'terminus'));
    expect(defaultStateDir('linux', { HOME: '/home/dev', XDG_STATE_HOME: '/custom/state' }))
      .toBe(path.join('/custom/state', 'terminus'));
  });

  it('Windows → %LOCALAPPDATA%\\Terminus, else ~/AppData/Local/Terminus', () => {
    expect(defaultStateDir('win32', { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }))
      .toBe(path.join('C:\\Users\\dev\\AppData\\Local', 'Terminus'));
    expect(defaultStateDir('win32', { USERPROFILE: 'C:\\Users\\dev' }))
      .toBe(path.join('C:\\Users\\dev', 'AppData', 'Local', 'Terminus'));
  });

  it('TERMINUS_STATE_DIR overrides every platform', () => {
    const env = { TERMINUS_STATE_DIR: '/tmp/override', HOME: '/home/dev' };
    for (const p of ['darwin', 'linux', 'win32'] as const) {
      expect(defaultStateDir(p, env)).toBe(path.resolve('/tmp/override'));
    }
  });

  it('falls back to the deprecated NETCAPTURE_STATE_DIR override', () => {
    expect(defaultStateDir('linux', { NETCAPTURE_STATE_DIR: '/tmp/legacy', HOME: '/home/dev' }))
      .toBe(path.resolve('/tmp/legacy'));
  });
});
