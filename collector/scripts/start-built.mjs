import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Collector package root (this file lives in <root>/scripts).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The compiled artifacts a prebuilt start needs. dist/main.js is the entry;
// dist-ui/* is served by the UI listener. Missing any of them means the tree was
// never built (or only partly) — we refuse rather than start a half-broken server.
const REQUIRED = ['dist/main.js', 'dist-ui/index.html', 'dist-ui/app.js', 'dist-ui/app.css'];

// Pure check: which required artifacts are absent under `root`. No side effects —
// start:built never rebuilds; it only runs what `npm run build` already produced.
export function checkArtifacts(dir) {
  const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(dir, rel)));
  return { ok: missing.length === 0, missing };
}

export function missingMessage(missing) {
  return [
    `terminus: build artifacts are missing (${missing.join(', ')}).`,
    'start:built runs the compiled server without rebuilding. Run `npm run build` first,',
    'or use `npm start` to build and start in one step.',
  ].join('\n');
}

function main() {
  const { ok, missing } = checkArtifacts(root);
  if (!ok) {
    console.error(missingMessage(missing));
    process.exit(1);
  }

  const child = spawn(process.execPath, [path.join(root, 'dist', 'main.js')], {
    cwd: root,
    stdio: 'inherit',
  });

  // Forward the stop signal to the compiled server as SIGINT so its own handler
  // closes the listeners and frees the ports, then mirror its exit. Forwarding
  // (rather than ignoring) matters when a supervisor signals only this launcher and
  // not the whole group; the re-entry guard keeps a TTY's group delivery from
  // double-signalling. main.js also has a 2s backstop, so shutdown always completes.
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; if (child.exitCode == null) child.kill('SIGINT'); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error('terminus: failed to start compiled server:', err.message);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
