import { defineConfig } from '@playwright/test';

// The browser specs start their own in-process collector harness (see
// test/browser/capture.spec.ts) and drive its store directly, so no webServer
// is configured here. Build the UI (npm run ui:build) before running, so the
// harness can serve dist-ui — `npm run test:browser` does both.
export default defineConfig({
  testDir: 'test/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { headless: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
