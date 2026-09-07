import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain ESM script, no type declarations.
import { checkArtifacts, missingMessage } from '../scripts/start-built.mjs';
// @ts-expect-error — plain ESM script, no type declarations.
import { childExitCode, createSupervisor } from '../scripts/dev.mjs';

// A stand-in for a spawned child: records kill signals and lets a test fire the
// exit/error events the supervisor listens for. `exitCode` mirrors a real
// ChildProcess so the supervisor's kill guard (only signal a still-running child)
// behaves as in production.
class FakeChild {
  exitCode: number | null = null;
  signalCode: string | null = null;
  private handlers: Record<string, (...a: unknown[]) => void> = {};
  kills: string[] = [];
  on(ev: string, cb: (...a: unknown[]) => void): this { this.handlers[ev] = cb; return this; }
  kill(sig: string): void { this.kills.push(sig); }
  fire(ev: string, ...args: unknown[]): void { this.handlers[ev]?.(...args); }
}

function wire() {
  const ui = new FakeChild();
  const backend = new FakeChild();
  const exits: number[] = [];
  const kill = (child: FakeChild, sig: string) => { if (child.exitCode == null && child.signalCode == null) child.kill(sig); };
  const log = { info: () => {}, error: () => {} };
  const sup = createSupervisor({ ui, backend, kill, exit: (c: number) => exits.push(c), log });
  return { ui, backend, exits, sup };
}

// start:built must never rebuild: it only decides whether the compiled tree is
// present and then runs it. These tests pin the pure guard that decision rests on.
describe('start:built artifact guard', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-startbuilt-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports every required artifact as missing for an unbuilt tree', () => {
    const { ok, missing } = checkArtifacts(dir);
    expect(ok).toBe(false);
    expect(missing).toEqual(['dist/main.js', 'dist-ui/index.html', 'dist-ui/app.js', 'dist-ui/app.css']);
  });

  it('does not create or build anything while checking (no rebuild)', () => {
    checkArtifacts(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('flags a partially built tree', () => {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'main.js'), '');
    const { ok, missing } = checkArtifacts(dir);
    expect(ok).toBe(false);
    expect(missing).toEqual(['dist-ui/index.html', 'dist-ui/app.js', 'dist-ui/app.css']);
  });

  it('passes once all artifacts exist', () => {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist-ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'main.js'), '');
    fs.writeFileSync(path.join(dir, 'dist-ui', 'index.html'), '');
    fs.writeFileSync(path.join(dir, 'dist-ui', 'app.js'), '');
    fs.writeFileSync(path.join(dir, 'dist-ui', 'app.css'), '');
    const { ok, missing } = checkArtifacts(dir);
    expect(ok).toBe(true);
    expect(missing).toEqual([]);
  });

  it('gives an actionable message that points at the build step', () => {
    const msg = missingMessage(['dist/main.js']);
    expect(msg).toContain('dist/main.js');
    expect(msg).toContain('npm run build');
  });
});

// dev.mjs supervises two children (vite watcher + tsx backend). Either dying, a
// spawn error, or a stop signal must tear down BOTH and exit with a meaningful
// code — never leave one child orphaned holding 8787/8788/10909.
describe('dev supervisor', () => {
  it('propagates a numeric exit code and maps a signal death (null code) to 0', () => {
    expect(childExitCode(2)).toBe(2);
    expect(childExitCode(0)).toBe(0);
    expect(childExitCode(null)).toBe(0); // killed by signal → null code → clean 0
  });

  it('tears down the UI watcher and exits with the code when the backend dies', () => {
    const { ui, backend, exits } = wire();
    backend.fire('exit', 3, null);
    expect(ui.kills).toEqual(['SIGTERM']);
    expect(exits).toEqual([3]);
  });

  it('tears down the backend when the UI watcher dies (previously it was left running)', () => {
    const { ui, backend, exits } = wire();
    ui.fire('exit', 0, null);
    expect(backend.kills).toEqual(['SIGTERM']);
    expect(exits).toEqual([0]);
  });

  it('treats SIGINT and SIGTERM identically: both children are stopped', () => {
    const a = wire();
    a.sup.onSignal('SIGINT');
    expect(a.ui.kills).toEqual(['SIGTERM']);
    expect(a.backend.kills).toEqual(['SIGTERM']);

    const b = wire();
    b.sup.onSignal('SIGTERM');
    expect(b.ui.kills).toEqual(['SIGTERM']);
    expect(b.backend.kills).toEqual(['SIGTERM']);
  });

  it('exits 1 and stops the UI when the backend fails to spawn', () => {
    const { ui, backend, exits } = wire();
    backend.fire('error', new Error('ENOENT'));
    expect(ui.kills).toEqual(['SIGTERM']);
    expect(exits).toEqual([1]);
  });

  it('exits once — the first child to go wins, the later exit is a no-op', () => {
    const { ui, backend, exits } = wire();
    backend.fire('exit', 5, null);
    backend.exitCode = 5;
    ui.fire('exit', 0, null); // arrives after we already finished
    expect(exits).toEqual([5]);
  });
});
