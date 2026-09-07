import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollectorHarness, type CollectorHarness } from '../fixtures/harness.js';
import type { PairingImport } from '../../src/security/types.js';

// Serve the built browser bundle; `npm run test:browser` builds first.
const distUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist-ui');

// A valid pairing blob for the wired harness: the /api/pairing route JSON-stringifies
// whatever getPairing returns, and the card reads host/ports/fingerprint/token.
const PAIRING: PairingImport = {
  collectorId: '11111111-2222-4333-8444-555555555555',
  host: '192.168.1.50',
  ingestPort: 8788,
  atlantisPort: 10909,
  certificateDerBase64: Buffer.from('fake-der-bytes').toString('base64'),
  certificateSha256: 'ab'.repeat(32),
  deviceToken: 'device-token-abcdef',
};

test.describe('Devices with a wired pairing blob', () => {
  let h: CollectorHarness;

  test.beforeEach(async ({ page }) => {
    h = await createCollectorHarness({ uiDir: distUi, getPairing: () => PAIRING });
    await page.goto(`${h.url}/#token=${h.adminToken}`);
    await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');
  });
  test.afterEach(async () => { await h.close(); });

  test('lists a connected device and shows the pairing host', async ({ page }) => {
    h.store.applyDeviceMessage('dev-01', { type: 'hello', deviceId: 'dev-01', platform: 'ios', appVersion: '3.4.1', buildProfile: 'qa', dropped: 0, ts: Date.now() });

    await page.getByRole('button', { name: 'Devices', exact: true }).click();

    // The device grid renders one card for the connected device.
    await expect(page.getByTestId('device-card')).toHaveCount(1);
    await expect(page.getByTestId('device-card')).toContainText('v3.4.1');

    // The pairing card resolves the wired blob: the LAN address carries the host.
    await expect(page.getByText(`${PAIRING.host}:${PAIRING.ingestPort}`)).toBeVisible();
    await expect(page.getByTestId('pairing-code')).toHaveText('ABA BAB');
  });
});

test.describe('Devices with an unminted identity', () => {
  let h: CollectorHarness;

  test.beforeEach(async ({ page }) => {
    // No getPairing → /api/pairing answers 503 → the card shows the fallback.
    h = await createCollectorHarness({ uiDir: distUi });
    await page.goto(`${h.url}/#token=${h.adminToken}`);
    await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');
  });
  test.afterEach(async () => { await h.close(); });

  test('the pairing card falls back to unavailable (503)', async ({ page }) => {
    await page.getByRole('button', { name: 'Devices', exact: true }).click();
    await expect(page.getByText('Pairing unavailable (identity not ready)')).toBeVisible();
  });
});
