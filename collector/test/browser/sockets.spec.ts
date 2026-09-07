import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollectorHarness, type CollectorHarness } from '../fixtures/harness.js';

// Serve the built browser bundle; `npm run test:browser` builds first.
const distUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist-ui');

let h: CollectorHarness;
test.beforeEach(async () => { h = await createCollectorHarness({ uiDir: distUi }); });
test.afterEach(async () => { await h.close(); });

test('the SSE filter narrows the session list to SSE streams', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  // One websocket and one SSE stream; both land as deltas and show in the list.
  h.store.addWsSession({ wsId: 'sock1', deviceId: 'd1', source: 'xhr', url: 'wss://ws.example.com/live', openedAt: 1, frames: [], closedAt: null, closeCode: null, closeReason: '' });
  h.store.addWsSession({ wsId: 'sse1', deviceId: 'd1', source: 'xhr', kind: 'sse', url: 'https://api.example.com/events', openedAt: 2, frames: [], closedAt: null, closeCode: null, closeReason: '' });

  await page.getByRole('button', { name: 'Sockets' }).click();
  await expect(page.getByTestId('ws-row-sock1')).toBeVisible();
  await expect(page.getByTestId('ws-row-sse1')).toBeVisible();

  // The SSE chip (session-list filter group) keeps only the SSE stream.
  await page.getByRole('group', { name: 'Filter sessions' }).getByRole('button', { name: 'SSE' }).click();
  await expect(page.getByTestId('ws-row-sse1')).toBeVisible();
  await expect(page.getByTestId('ws-row-sock1')).toHaveCount(0);
});

test('expanding a frame loads its payload text on demand', async ({ page }) => {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');

  h.store.addWsSession({ wsId: 'sock2', deviceId: 'd1', source: 'xhr', url: 'wss://ws.example.com/live', openedAt: 1, frames: [], closedAt: null, closeCode: null, closeReason: '' });
  h.store.appendWsFrame('sock2', { ts: 2, direction: 'in', data: '{"type":"tick","seq":7}', size: 23, binary: false });

  await page.getByRole('button', { name: 'Sockets' }).click();
  await page.getByTestId('ws-row-sock2').click();
  await page.getByTestId('ws-frame-0').click();
  await expect(page.getByTestId('frame-body-text')).toContainText('"type":"tick"');
});
