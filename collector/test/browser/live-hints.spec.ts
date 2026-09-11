import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollectorHarness, type CollectorHarness } from '../fixtures/harness.js';
import type { Entry } from '../../src/types.js';

// Repro specs for the "never look frozen" live-hints work: traffic streams in but
// view state (a device filter, a non-time sort, a scrolled list) hides it. Serves
// the built browser bundle; `npm run test:browser` builds first.
const distUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist-ui');

let h: CollectorHarness;
test.beforeEach(async () => { h = await createCollectorHarness({ uiDir: distUi }); });
test.afterEach(async () => { await h.close(); });

// A complete legacy Entry inserted straight into the real store.
function makeEntry(id: string, deviceId: string, over: Partial<Entry> = {}): Entry {
  return {
    id, deviceId, source: 'xhr', startedAt: 1, method: 'GET', url: `https://demo.test/${id}`,
    requestHeaders: {}, requestBody: null, requestBodySize: 0, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: {}, responseBody: null, responseBodySize: 0,
    responseBodyOmitted: null, durationMs: 1, error: null, ...over,
  };
}

test('item 1: a pill counts arrivals on other devices and "Show all" reveals them', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  // Two devices announce themselves so both are selectable in the switcher.
  h.store.applyDeviceMessage('dev-a', { type: 'hello', deviceId: 'dev-a', platform: 'ios', appVersion: '1.0', buildProfile: 'qa', dropped: 0, ts: Date.now() });
  h.store.applyDeviceMessage('dev-b', { type: 'hello', deviceId: 'dev-b', platform: 'android', appVersion: '1.0', buildProfile: 'qa', dropped: 0, ts: Date.now() });

  // A row on dev-a so the table is showing that device's traffic.
  h.store.addEntry(makeEntry('a0', 'dev-a'));
  await expect(page.getByTestId('entry-row-a0')).toBeVisible();

  // Select dev-a in the switcher. From here, arrivals under dev-b are "elsewhere".
  await page.getByRole('combobox', { name: 'Select device' }).selectOption('dev-a');

  // No pill yet — nothing has arrived on another device since the selection.
  await expect(page.getByTestId('other-device-pill')).toHaveCount(0);

  // Traffic streams in under dev-b while dev-a is selected: the view would look
  // frozen without the pill.
  h.store.addEntry(makeEntry('b0', 'dev-b'));
  h.store.addEntry(makeEntry('b1', 'dev-b'));
  const pill = page.getByTestId('other-device-pill');
  await expect(pill).toContainText('2 new on other devices');

  // dev-b rows are filtered out while dev-a is selected.
  await expect(page.getByTestId('entry-row-b0')).toHaveCount(0);

  // "Show all" switches to every device and reveals the hidden rows.
  await pill.click();
  await expect(page.getByTestId('entry-row-b0')).toBeVisible();
  await expect(page.getByTestId('entry-row-b1')).toBeVisible();
  await expect(page.getByTestId('other-device-pill')).toHaveCount(0);
});
