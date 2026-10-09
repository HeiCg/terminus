import { defineConfig } from 'vitest/config';

// Node-environment vitest for the MCP server. Tests spin up a real collector on an
// ephemeral loopback port via the collector's own harness and drive the server
// through the SDK's in-memory transport, so no build step and no stdio are involved.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
