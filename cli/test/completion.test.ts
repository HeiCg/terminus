import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { runCli } from './helpers.js';

// `terminus completion <shell>` is offline (no collector, no token), so these run
// without a harness. Each script is asserted structurally and, when the shell is on
// PATH, syntax-checked with its own `-n` (skipped with a reason otherwise).
const has = (bin: string): boolean => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0
  || spawnSync(bin, ['-c', 'true'], { stdio: 'ignore' }).status === 0;

describe('terminus completion (T7.4)', () => {
  it('emits a bash script covering commands, flags and enum values', async () => {
    const r = await runCli(['completion', 'bash']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('complete -F _terminus terminus');
    expect(r.stdout).toContain('replay'); // the new command is listed
    expect(r.stdout).toContain('--source) COMPREPLY=( $(compgen -W "xhr atlantis proxy replay"');
    expect(r.stdout).toContain('--body) COMPREPLY=( $(compgen -W "request response both none"');
    expect(r.stdout).toContain('--status) COMPREPLY=( $(compgen -W "1xx 2xx 3xx 4xx 5xx"');
  });

  it('emits a zsh script (#compdef terminus)', async () => {
    const r = await runCli(['completion', 'zsh']);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('#compdef terminus')).toBe(true);
    expect(r.stdout).toContain("'replay:");
    expect(r.stdout).toContain("--source) compadd 'xhr' 'atlantis' 'proxy' 'replay'");
  });

  it('emits a fish script', async () => {
    const r = await runCli(['completion', 'fish']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("complete -c terminus -n '__fish_use_subcommand' -a 'replay'");
    expect(r.stdout).toContain("-l source -x -a 'xhr atlantis proxy replay'");
  });

  it('rejects an unknown or missing shell', async () => {
    const bad = await runCli(['completion', 'powershell']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('usage: terminus completion');
    const none = await runCli(['completion']);
    expect(none.code).toBe(1);
  });

  it('the generated bash script passes `bash -n`', async () => {
    if (!has('bash')) { console.warn('skip: bash not on PATH'); return; }
    const r = await runCli(['completion', 'bash']);
    const check = spawnSync('bash', ['-n'], { input: r.stdout });
    expect(check.status, check.stderr?.toString()).toBe(0);
  });

  it('the generated zsh script passes `zsh -n`', async () => {
    if (!has('zsh')) { console.warn('skip: zsh not on PATH'); return; }
    const r = await runCli(['completion', 'zsh']);
    const check = spawnSync('zsh', ['-n'], { input: r.stdout });
    expect(check.status, check.stderr?.toString()).toBe(0);
  });
});
