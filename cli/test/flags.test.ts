import { describe, it, expect } from 'vitest';
import { runCli } from './helpers.js';

// Flag validation runs before any connection, so these need no collector.
describe('flag validation', () => {
  it('rejects an unknown flag with exit 1 and a suggestion', async () => {
    const r = await runCli(['ls', '--stauts', '5xx']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown flag --stauts');
    expect(r.stderr).toContain('did you mean --status?');
  });

  it('rejects a non-numeric --limit with exit 1', async () => {
    const r = await runCli(['ls', '--limit', 'abc']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--limit');
    expect(r.stderr).toContain('number');
  });

  it('rejects a non-numeric --last with exit 1', async () => {
    const r = await runCli(['tail', '--last', 'abc']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--last');
  });

  it('rejects an invalid --status token, listing the accepted forms', async () => {
    const r = await runCli(['ls', '--status', 'zzz']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('invalid --status');
    expect(r.stderr).toContain('1xx');
  });

  it('accepts a mixed --status list of codes and classes at validation time', async () => {
    // No collector, so it fails to connect (exit 3) — but NOT on validation (exit 1).
    const r = await runCli(['ls', '--status', '200,4xx,5xx'], { env: { TERMINUS_TOKEN: 't', TERMINUS_PORT: '1' } });
    expect(r.code).not.toBe(1);
  });

  it('rejects an invalid --body enum on show', async () => {
    const r = await runCli(['show', 'd1/r1', '--body', 'sideways']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('invalid --body');
    expect(r.stderr).toContain('request');
  });
});

describe('per-command help', () => {
  it('prints the command flags, not the global usage', async () => {
    const r = await runCli(['ls', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('terminus ls —');
    expect(r.stdout).toContain('--limit');
    expect(r.stdout).toContain('Common:');
    expect(r.stdout).not.toContain('Commands:'); // the global USAGE header
  });

  it('the bare --help still prints the global usage', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Commands:');
  });
});
