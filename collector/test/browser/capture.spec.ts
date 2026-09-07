import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollectorHarness, type CollectorHarness } from '../fixtures/harness.js';

// Serve the built browser bundle; `npm run test:ui` runs the build first.
const distUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist-ui');

let h: CollectorHarness;
test.beforeEach(async () => { h = await createCollectorHarness({ uiDir: distUi }); });
test.afterEach(async () => { await h.close(); });

test('authenticates from the fragment and streams an incremental frame', async ({ page }) => {
  // The terminal link carries the admin token in the fragment; the UI trades it
  // for a cookie and strips the fragment before any request.
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');
  expect(new URL(page.url()).hash).toBe('');

  // Drive the real store: the server emits the production envelopes and the
  // page applies them incrementally, with no reload.
  h.store.addWsSession({ wsId: 'w1', deviceId: 'd1', source: 'xhr', url: 'wss://example.test/ws', openedAt: 1, frames: [], closedAt: null, closeCode: null, closeReason: '' });
  h.store.appendWsFrame('w1', { ts: 2, direction: 'in', data: 'fixture-frame', size: 13, binary: false });

  // The frame list is paged from /api on selection (payload not in the stream);
  // the frame's payload loads only when the row is expanded.
  await page.getByRole('button', { name: 'Sockets' }).click();
  await page.getByTestId('ws-row-w1').click();
  await page.getByTestId('ws-frame-0').click();
  await expect(page.getByTestId('frame-body-text')).toContainText('fixture-frame');
});

test('the frame pane shows the newest window for a session with >200 frames', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  h.store.addWsSession({ wsId: 'wbig', deviceId: 'd1', source: 'xhr', url: 'wss://example.test/big', openedAt: 1, frames: [], closedAt: null, closeCode: null, closeReason: '' });
  for (let i = 0; i < 250; i++) h.store.appendWsFrame('wbig', { ts: i, direction: 'in', data: `f${i}`, size: 2, binary: false }, null, 'd1');

  await page.getByRole('button', { name: 'Sockets' }).click();
  await page.getByTestId('ws-row-wbig').click();
  // Newest 200 (sequences 50..249): the newest is shown, the oldest are not.
  await expect(page.getByTestId('ws-frame-249')).toBeVisible();
  await expect(page.getByTestId('ws-frame-0')).toHaveCount(0);
  await expect(page.getByTestId('ws-frame-49')).toHaveCount(0);
});

test('a frame delta during the initial fetch still lands on the newest window', async ({ page }) => {
  // Delay the frames fetch so a live delta can arrive while it is in flight,
  // re-running the load effect with an empty-but-not-fresh held state.
  await page.route('**/frames**', async (route) => { await new Promise((r) => setTimeout(r, 400)); await route.continue(); });

  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  h.store.addWsSession({ wsId: 'wrace', deviceId: 'd1', source: 'xhr', url: 'wss://example.test/race', openedAt: 1, frames: [], closedAt: null, closeCode: null, closeReason: '' });
  for (let i = 0; i < 250; i++) h.store.appendWsFrame('wrace', { ts: i, direction: 'in', data: `f${i}`, size: 2, binary: false }, null, 'd1');

  await page.getByRole('button', { name: 'Sockets' }).click();
  await page.getByTestId('ws-row-wrace').click();               // starts the (delayed) initial tail fetch
  await page.waitForTimeout(100);                                // …still in flight
  h.store.appendWsFrame('wrace', { ts: 250, direction: 'in', data: 'f250', size: 2, binary: false }, null, 'd1'); // bumps totalFrames → effect re-runs with empty held

  // The pane must still land on the newest window, never the oldest.
  await expect(page.getByTestId('ws-frame-250')).toBeVisible();
  await expect(page.getByTestId('ws-frame-0')).toHaveCount(0);
});

// A complete byte input (Atlantis-style) the test inserts into the real store.
function entryInput(over: Record<string, unknown> = {}) {
  return {
    id: 'r1', deviceId: 'd1', source: 'atlantis' as const, startedAt: 1, method: 'GET', url: 'https://api.test/thing',
    requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/json' },
    responseBytes: null, responseBodySize: 0, responseBodyOmitted: null, durationMs: 1, error: null, ...over,
  };
}

test('fetches an entry body on demand and pretty-prints it (never in the socket stream)', async ({ page }) => {
  // Capture every /ui socket frame so we can assert the body bytes never travel it.
  const wsFrames: string[] = [];
  page.on('websocket', (ws) => ws.on('framereceived', (ev) => { if (typeof ev.payload === 'string') wsFrames.push(ev.payload); }));

  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  // The marker is escape-free (no quotes/backslashes), so it would survive JSON
  // escaping if the body were ever inlined into a socket frame — making the
  // absence assertion below able to actually fail.
  const marker = 'SECRET-BODY-MARKER';
  const json = `{"ok":true,"tag":"${marker}"}`;
  h.store.addEntryInput(entryInput({ responseBytes: new Uint8Array(Buffer.from(json)), responseBodySize: json.length }) as never);
  await expect(page.getByTestId('entry-row-r1')).toBeVisible(); // delta (a summary) arrived

  // The body bytes are in NONE of the socket frames (snapshot + entry summary).
  expect(wsFrames.some((f) => f.includes(marker))).toBe(false);

  await page.getByTestId('entry-row-r1').click();
  // Response is the default tab; selecting the row loads its response body.
  // Fetched from /api/.../body and pretty-printed by the browser cache.
  await expect(page.getByTestId('body-response')).toContainText('"ok": true');
  await expect(page.getByTestId('body-response')).toContainText(marker);
});

test('clearing the store drops the selection and its detail', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  h.store.addEntryInput(entryInput() as never);
  await page.getByTestId('entry-row-r1').click();
  await expect(page.getByRole('button', { name: 'Copy as cURL' })).toBeVisible();

  h.store.clear();
  await expect(page.getByTestId('entry-row-r1')).toHaveCount(0);
  // Selection cleared: the detail panel unmounts and the table returns to full width.
  await expect(page.getByTestId('detail-panel')).toHaveCount(0);
});

test('export and clear controls work over the session cookie', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  h.store.addWsSession({ wsId: 'w2', deviceId: 'd9', source: 'xhr', url: 'wss://example.test/x', openedAt: 1, frames: [], closedAt: null, closeCode: null, closeReason: '' });
  // The session shows in the standalone Sockets view (reached via the sidebar).
  await page.getByRole('button', { name: 'Sockets' }).click();
  await expect(page.getByTestId('ws-row-w2')).toBeVisible();

  // Export and clear live in the Capture topbar.
  await page.getByRole('button', { name: 'Capture' }).click();

  // Export downloads authenticate with the cookie, not a query token. The export
  // menu is a dropdown — open it, then pick JSON.
  await page.getByRole('button', { name: 'Export ▾' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export JSON' }).click(),
  ]);
  expect(new URL(download.url()).search).not.toContain('token');

  // Clear runs same-origin (cookie + Origin) and empties the store. `exact` picks
  // the topbar Clear over the filter bar's "Clear filters".
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect.poll(() => h.store.wsSessions().length).toBe(0);
  await page.getByRole('button', { name: 'Sockets' }).click();
  await expect(page.getByTestId('ws-row-w2')).toHaveCount(0);
});
