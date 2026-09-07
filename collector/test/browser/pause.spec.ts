import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollectorHarness, type CollectorHarness } from '../fixtures/harness.js';
import type { Entry } from '../../src/types.js';

// Serve the built browser bundle; `npm run test:ui`/`test:browser` builds first.
const distUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist-ui');

let h: CollectorHarness;
test.beforeEach(async () => { h = await createCollectorHarness({ uiDir: distUi }); });
test.afterEach(async () => { await h.close(); });

// A complete legacy Entry the test inserts straight into the real store.
function makeEntry(id: string): Entry {
  return {
    id, deviceId: 'd1', source: 'xhr', startedAt: 1, method: 'GET', url: `https://demo.test/${id}`,
    requestHeaders: {}, requestBody: null, requestBodySize: 0, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: {}, responseBody: null, responseBodySize: 0,
    responseBodyOmitted: null, durationMs: 1, error: null,
  };
}

test('pausing suppresses live deltas; resume resyncs them via a fresh snapshot', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  // A pre-pause entry proves the live pipeline is flowing before we pause.
  h.store.addEntry(makeEntry('p0'));
  await expect(page.getByTestId('entry-row-p0')).toBeVisible();

  // Pause the broadcaster over the real POST /api/pause round-trip. The pill
  // becoming visible is the deterministic barrier that the `paused` message has
  // been applied client-side — no arbitrary timeout needed.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(page.getByTestId('paused-pill')).toBeVisible();

  // Captured WHILE paused: the store records it but the delta is withheld. Since
  // the server suppresses it synchronously (pause precedes the add), the row is
  // deterministically absent — no in-flight delta can arrive.
  h.store.addEntry(makeEntry('p1'));
  await expect(page.getByTestId('entry-row-p1')).toHaveCount(0);
  await expect(page.getByTestId('entry-row-p0')).toBeVisible(); // the pre-pause row is still shown

  // Resume: the server announces paused:false then re-sends a full snapshot that
  // carries the entry added while paused, so p1 now lands.
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.getByTestId('entry-row-p1')).toBeVisible();

  // Live deltas flow again: a post-resume entry streams straight in — the
  // barrier that the stream fully recovered.
  h.store.addEntry(makeEntry('p2'));
  await expect(page.getByTestId('entry-row-p2')).toBeVisible();
});
