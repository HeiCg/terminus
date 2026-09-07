import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollectorHarness, type CollectorHarness } from '../fixtures/harness.js';

// Serve the built browser bundle; `npm run test:browser` builds first.
const distUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist-ui');

let h: CollectorHarness;
test.beforeEach(async () => { h = await createCollectorHarness({ uiDir: distUi }); });
test.afterEach(async () => { await h.close(); });

// A complete byte input the test inserts into the real store (mirrors capture.spec).
function entryInput(over: Record<string, unknown> = {}) {
  return {
    id: 'r1', deviceId: 'd1', source: 'atlantis' as const, startedAt: 1, method: 'GET', url: 'https://api.example.com/thing',
    requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/json' },
    responseBytes: null, responseBodySize: 0, responseBodyOmitted: null, durationMs: 1, error: null, ...over,
  };
}

const ROWS = '[data-testid^="entry-row-"]';

// Seed 50 entries: 44 plain 2xx (`g-*`), 3 carrying `checkout` in the url (`c-*`),
// and 3 with a 404 status (`x-404-*`). The 404 rows get the largest `startedAt`
// so the default newest-first sort puts them at the top of the (virtualized)
// table — a deterministic barrier that every delta has landed.
async function seed50(): Promise<void> {
  let ts = 1;
  for (let i = 0; i < 44; i++) {
    h.store.addEntryInput(entryInput({ id: `g-${i}`, startedAt: ts++, url: `https://api.example.com/thing/${i}` }) as never);
  }
  for (let i = 0; i < 3; i++) {
    h.store.addEntryInput(entryInput({ id: `c-${i}`, startedAt: ts++, url: `https://api.example.com/checkout/${i}` }) as never);
  }
  for (let i = 0; i < 3; i++) {
    h.store.addEntryInput(entryInput({ id: `x-404-${i}`, startedAt: ts++, status: 404, statusText: 'Not Found', url: `https://api.example.com/missing/${i}` }) as never);
  }
}

test('the 4xx status chip narrows the table to only 4xx rows', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  await seed50();
  // The newest rows (the 404s) sit at the top of the fresh, time-desc table.
  await expect(page.getByTestId('entry-row-x-404-2')).toBeVisible();

  await page.getByRole('button', { name: '4xx' }).click();

  // Exactly the three 404 rows remain — no 2xx row survives the chip.
  await expect(page.locator(ROWS)).toHaveCount(3);
  await expect(page.getByTestId('entry-row-x-404-0')).toBeVisible();
  await expect(page.getByTestId('entry-row-x-404-1')).toBeVisible();
  await expect(page.getByTestId('entry-row-x-404-2')).toBeVisible();
  await expect(page.getByTestId('entry-row-g-0')).toHaveCount(0);
});

test('the topbar search narrows the table by url', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  await seed50();
  await expect(page.getByTestId('entry-row-x-404-2')).toBeVisible();

  await page.getByTestId('search').fill('checkout');

  // Only the three `checkout` urls match; the 2xx `thing` and 404 `missing` rows drop.
  await expect(page.locator(ROWS)).toHaveCount(3);
  await expect(page.getByTestId('entry-row-c-0')).toBeVisible();
  await expect(page.getByTestId('entry-row-g-0')).toHaveCount(0);
  await expect(page.getByTestId('entry-row-x-404-0')).toHaveCount(0);
});
