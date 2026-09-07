import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollectorHarness, type CollectorHarness } from '../fixtures/harness.js';

// Serve the built browser bundle; `npm run test:browser` builds first.
const distUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist-ui');

let h: CollectorHarness;
test.beforeEach(async () => { h = await createCollectorHarness({ uiDir: distUi }); });
test.afterEach(async () => { await h.close(); });

function entryInput(over: Record<string, unknown> = {}) {
  return {
    id: 'r1', deviceId: 'd1', source: 'atlantis' as const, startedAt: 1, method: 'GET', url: 'https://api.example.com/thing',
    requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/json' },
    responseBytes: null, responseBodySize: 0, responseBodyOmitted: null, durationMs: 1, error: null, ...over,
  };
}

test('the Response tab shows the omitted-body card for an omitted BodyRef', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  // A response body declared but dropped for size: the store records an `omitted`
  // BodyRef (no bytes), so the /body route answers 410 and the pane renders the
  // card rather than a body. `size` travels so the card can show the original.
  h.store.addEntryInput(entryInput({ id: 'om1', responseBytes: null, responseBodyOmitted: 'size', responseBodySize: 2_000_000 }) as never);
  await expect(page.getByTestId('entry-row-om1')).toBeVisible();

  await page.getByTestId('entry-row-om1').click();
  // Response is the default tab; the omitted ref resolves synchronously (no fetch),
  // so the card shows the reason and the original size.
  const panel = page.getByTestId('detail-panel');
  await expect(panel.getByText('Body omitted — size')).toBeVisible();
  await expect(panel.getByText('Larger than the per-body cap.')).toBeVisible();
  // The `body-response` container is only present for a materialized (ok) body.
  await expect(page.getByTestId('body-response')).toHaveCount(0);
});

test('the Headers and Timing tabs render the fetched detail', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  h.store.addEntryInput(entryInput({
    id: 'd1r', method: 'POST', durationMs: 42,
    requestHeaders: { 'x-req-marker': 'REQ-HDR-VALUE' },
    responseHeaders: { 'content-type': 'application/json', 'x-res-marker': 'RES-HDR-VALUE' },
  }) as never);
  await expect(page.getByTestId('entry-row-d1r')).toBeVisible();
  await page.getByTestId('entry-row-d1r').click();

  const panel = page.getByTestId('detail-panel');

  await panel.getByRole('tab', { name: 'Headers' }).click();
  await expect(panel.getByText('REQ-HDR-VALUE')).toBeVisible();
  await expect(panel.getByText('RES-HDR-VALUE')).toBeVisible();

  await panel.getByRole('tab', { name: 'Timing' }).click();
  await expect(panel.getByText('Phase breakdown not available from this source')).toBeVisible();
});
