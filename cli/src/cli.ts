#!/usr/bin/env node
// The published bin entry. It carries the shebang and calls run() unconditionally,
// so it works through npm's bin symlink (where argv[1] is the symlink path). It is a
// separate module from main.ts so importing main.ts (tests) never executes the CLI.
// tsc preserves the shebang in the emitted dist/cli/src/cli.js, which `bin` points at.
import { run } from './main.js';

void run();
