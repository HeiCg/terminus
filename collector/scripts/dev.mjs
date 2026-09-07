import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The exit code to propagate from a child that exited. A numeric code (a crash or
// a clean 0) is passed through so the dev process mirrors the child that failed;
// a signal death (our own SIGTERM during shutdown) carries no code and is a clean
// 0 — an intentional teardown, not a failure.
export function childExitCode(code) {
  return typeof code === 'number' ? code : 0;
}

// Wire the two dev children (vite watcher + tsx backend) so that ANY of them
// stopping tears down the other and drives the process exit. Injectable
// (children, kill, exit, log) so it is unit-testable without spawning anything.
//
// Rules:
//  - either child's `exit` stops the sibling and exits with that child's code;
//  - either child's spawn `error` stops the sibling and exits 1;
//  - a stop signal (SIGINT/SIGTERM, handled identically) stops both children and
//    lets their exits settle the code;
//  - the first terminal event wins; later events are no-ops (guarded by `done`).
export function createSupervisor({ ui, backend, kill, exit, log }) {
  let done = false;
  const finish = (code) => { if (done) return; done = true; exit(code); };

  backend.on('exit', (code) => { kill(ui, 'SIGTERM'); finish(childExitCode(code)); });
  ui.on('exit', (code) => { kill(backend, 'SIGTERM'); finish(childExitCode(code)); });
  backend.on('error', (err) => {
    log.error('[dev] failed to start backend:', err.message);
    kill(ui, 'SIGTERM'); finish(1);
  });
  ui.on('error', (err) => {
    log.error('[dev] failed to start vite watcher:', err.message);
    kill(backend, 'SIGTERM'); finish(1);
  });

  return {
    // SIGINT and SIGTERM are treated the same: stop both children, then their
    // exits (via the handlers above) settle the final code.
    onSignal(signal) {
      log.info(`\n[dev] shutting down (${signal})…`);
      kill(ui, 'SIGTERM');
      kill(backend, 'SIGTERM');
    },
  };
}

function main() {
  // Collector package root (this file lives in <root>/scripts). Pin cwd to the root
  // so `node scripts/dev.mjs` works regardless of where it was launched from.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(root);

  // Dev flow: `vite build --watch` keeps dist-ui fresh (bundle + index.html + fonts,
  // same output as the shipped build), and `tsx watch` runs the backend from src/,
  // restarting itself on any src change and serving dist-ui. index.html is part of
  // vite's graph now, so there is no separate file watcher to maintain.
  const viteBin = path.join(root, 'node_modules', '.bin', 'vite');
  const ui = spawn(viteBin, ['build', '-c', 'ui/vite.config.ts', '--watch'], { cwd: root, stdio: 'inherit' });
  console.log('[dev] UI: vite build --watch (dist-ui)');

  // tsx already watches src/ and restarts the backend on change; it also rebinds the
  // listeners, so a change in http.ts or main.ts is picked up live. Stopping it tears
  // down its child (the collector), which closes the listeners and frees 8787/8788/10909.
  const tsxBin = path.join(root, 'node_modules', '.bin', 'tsx');
  const backend = spawn(tsxBin, ['watch', 'src/main.ts'], { cwd: root, stdio: 'inherit' });
  console.log('[dev] backend: tsx watch src/main.ts');

  // Only signal a child that is still running: a child killed by a signal has a
  // null exitCode but a set signalCode, so guard on both to avoid signalling a
  // process that has already gone.
  const kill = (child, signal) => { if (child.exitCode == null && child.signalCode == null) child.kill(signal); };
  const sup = createSupervisor({ ui, backend, kill, exit: (code) => process.exit(code ?? 0), log: console });

  process.on('SIGINT', () => sup.onSignal('SIGINT'));
  process.on('SIGTERM', () => sup.onSignal('SIGTERM'));
}

// Run only when executed directly; importing this module (e.g. from tests) must
// not spawn anything.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
