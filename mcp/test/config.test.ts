import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { writeTokenFile } from '../../collector/src/security/adminToken.js';
import { createCollectorHarness } from '../../collector/test/fixtures/harness.js';
import { resolveSettings, describeSettings } from '../src/config.js';
import { tempStateDir, settingsFor, connect, call, text } from './helpers.js';

let dir: string;
beforeEach(() => { dir = tempStateDir(); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const resolve = (argv: string[], env: NodeJS.ProcessEnv = {}) => resolveSettings({ argv, env, stateDir: dir });

describe('token resolution order', () => {
  it('prefers --token, then TERMINUS_TOKEN, then reader-token, then admin-token', () => {
    writeTokenFile('reader-token', 'reader-tok', dir);
    writeTokenFile('admin-token', 'admin-tok', dir);
    expect(resolve(['--token', 'flag-tok'], { TERMINUS_TOKEN: 'env-tok' }).token()).toEqual({ token: 'flag-tok', source: 'flag' });
    expect(resolve([], { TERMINUS_TOKEN: 'env-tok' }).token()).toEqual({ token: 'env-tok', source: 'env' });
    expect(resolve([]).token()).toEqual({ token: 'reader-tok', source: 'reader-token' });
    fs.rmSync(`${dir}/reader-token`);
    expect(resolve([]).token()).toEqual({ token: 'admin-tok', source: 'admin-token' });
  });

  it('re-reads a token file on every call (the collector rotates tokens on restart)', () => {
    writeTokenFile('reader-token', 'before', dir);
    const s = resolve([]);
    expect(s.token().token).toBe('before');
    writeTokenFile('reader-token', 'after', dir);
    expect(s.token().token).toBe('after');
  });

  it('starts without any token and reports none in the log line', () => {
    const s = resolve([]);
    expect(s.startupSource).toBeNull();
    expect(() => s.token()).toThrow(/no token/);
    expect(describeSettings(s)).toContain('no token found yet');
  });

  it('never puts the token in the log line', () => {
    writeTokenFile('admin-token', 'super-secret-admin', dir);
    const s = resolve([], { TERMINUS_MCP_ALLOW_REPLAY: '1' });
    expect(describeSettings(s)).not.toContain('super-secret-admin');
    expect(describeSettings(s)).toContain('terminus_replay ENABLED');
  });
});

describe('admin detection and the replay opt-in', () => {
  it('treats the reader token as non-admin even with the opt-in', () => {
    writeTokenFile('reader-token', 'r', dir);
    writeTokenFile('admin-token', 'a', dir);
    const s = resolve([], { TERMINUS_MCP_ALLOW_REPLAY: '1' });
    expect(s.isAdmin).toBe(false);
    expect(s.replayEnabled).toBe(false);
    expect(describeSettings(s)).toContain('is set but the token is not the admin token');
  });

  it('recognises the admin token given by env when it equals the admin-token file', () => {
    writeTokenFile('reader-token', 'r', dir);
    writeTokenFile('admin-token', 'a', dir);
    expect(resolve([], { TERMINUS_TOKEN: 'a', TERMINUS_MCP_ALLOW_REPLAY: '1' }).replayEnabled).toBe(true);
    expect(resolve([], { TERMINUS_TOKEN: 'a' }).replayEnabled).toBe(false); // no opt-in
    expect(resolve([], { TERMINUS_TOKEN: 'a', TERMINUS_MCP_ALLOW_REPLAY: 'true' }).replayEnabled).toBe(false); // only "1"
  });
});

describe('connection resolution', () => {
  it('defaults to 127.0.0.1:8787 and honours flags over env', () => {
    expect(resolve([]).conn.baseUrl).toBe('http://127.0.0.1:8787');
    expect(resolve([], { TERMINUS_HOST: 'localhost', TERMINUS_PORT: '9000' }).conn.baseUrl).toBe('http://localhost:9000');
    expect(resolve(['--host', '127.0.0.1', '--port', '9999'], { TERMINUS_PORT: '9000' }).conn.baseUrl).toBe('http://127.0.0.1:9999');
  });

  it('rejects an invalid port at startup', () => {
    expect(() => resolve(['--port', 'abc'])).toThrow(/invalid port/);
  });
});

describe('end to end with token files', () => {
  it('authenticates with the reader-token file when both files exist', async () => {
    const h = await createCollectorHarness();
    try {
      writeTokenFile('reader-token', h.readerToken, dir);
      writeTokenFile('admin-token', 'not-the-admin-token', dir); // would 401 if used
      const c = await connect(settingsFor(h, { token: null, stateDir: dir }));
      try {
        const r = await call(c, 'terminus_status');
        expect(r.isError).toBeFalsy();
        expect(text(r)).toContain('Terminus collector');
      } finally { await c.close(); }
    } finally { await h.close(); }
  });

  it('a call without any token is a clear tool error, not a crash', async () => {
    const h = await createCollectorHarness();
    try {
      const c = await connect(settingsFor(h, { token: null, stateDir: dir }));
      try {
        const r = await call(c, 'terminus_entries');
        expect(r.isError).toBe(true);
        expect(text(r)).toContain('no token');
        expect(text(r)).toContain('reader-token');
      } finally { await c.close(); }
    } finally { await h.close(); }
  });
});
