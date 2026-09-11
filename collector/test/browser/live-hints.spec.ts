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

test('item 2: a non-time sort still raises a "Jump to newest" pill on arrivals', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  // A couple of rows so the table is populated, then sort by Host (a non-time
  // sort → no arrival edge → the old build showed no pill and looked frozen).
  h.store.addEntry(makeEntry('h0', 'd1', { url: 'https://alpha.test/0', startedAt: 1 }));
  h.store.addEntry(makeEntry('h1', 'd1', { url: 'https://beta.test/1', startedAt: 2 }));
  await expect(page.getByTestId('entry-row-h1')).toBeVisible();

  await page.getByRole('button', { name: /Host/i }).click(); // sort by host asc

  // A live arrival under the non-time sort: the pill appears (no edge to stick to).
  h.store.addEntry(makeEntry('h2', 'd1', { url: 'https://gamma.test/2', startedAt: 3 }));
  const pill = page.getByTestId('jump-newest');
  await expect(pill).toContainText('1 new · Jump to newest');

  // Clicking jumps back to time desc; the newest row sits at the top and the pill
  // clears (the scroller re-mounted at the newest edge).
  await pill.click();
  await expect(page.getByTestId('jump-newest')).toHaveCount(0);
  await expect(page.getByTestId('entry-row-h2')).toBeVisible();
});

test('item 2b: scrolled away under time desc, arrivals raise the "N new" pill', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  // Enough rows to scroll the virtualized list well away from the top edge.
  for (let i = 0; i < 80; i++) h.store.addEntry(makeEntry(`s${i}`, 'd1', { startedAt: i + 1 }));
  await expect(page.getByTestId('entry-row-s79')).toBeVisible(); // newest at top under time desc

  const scroll = page.getByTestId('request-scroll');
  await scroll.evaluate((el) => { el.scrollTop = 600; });

  // A fresh arrival while scrolled away: the "↑ N new" pill appears rather than
  // yanking the scroll position.
  h.store.addEntry(makeEntry('s-new', 'd1', { startedAt: 999 }));
  await expect(page.getByRole('button', { name: /↑ 1 new/ })).toBeVisible();
});

test('item 3: the topbar connection dot reflects live then paused', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  const dot = page.getByTestId('conn-dot');
  await expect(dot).toHaveAttribute('data-state', 'live');

  // Pausing the broadcaster flips the dot to paused (over the real POST /api/pause).
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByTestId('paused-pill')).toBeVisible();
  await expect(dot).toHaveAttribute('data-state', 'paused');
});

test('item 4: a captured zero-length body renders an explicit empty state', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  // A POST whose response body was captured but is empty (0 bytes). An empty
  // string body (not null) is a CAPTURED zero-length body, not an absent one.
  h.store.addEntry(makeEntry('empty0', 'd1', {
    method: 'POST', responseBody: '', responseHeaders: { 'content-type': 'application/json' },
  }));
  await page.getByTestId('entry-row-empty0').click();

  // Response is the default tab; the pane shows the empty state, not a blank box.
  await expect(page.getByTestId('body-response')).toContainText('Empty body (0 bytes)');
  await expect(page.getByTestId('body-response')).toContainText('application/json');
});
