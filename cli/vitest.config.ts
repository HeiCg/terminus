import { defineConfig } from 'vitest/config';

// Node-environment vitest for the CLI. Tests spin up a real collector on an
// ephemeral loopback port via the collector's own harness and drive the command
// functions in-process, so no build step and no browser are involved.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
