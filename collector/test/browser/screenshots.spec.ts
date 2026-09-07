import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollectorHarness, type CollectorHarness } from '../fixtures/harness.js';
import type { PairingImport } from '../../src/security/types.js';

// Screenshot capture for human comparison against Figma. SKIPPED by default —
// run once with `SHOTS=1 npx playwright test test/browser/screenshots.spec.ts`.
// Every image is a 1440×900 viewport PNG under docs/screenshots/.
const SHOTS = process.env.SHOTS === '1';

const here = path.dirname(fileURLToPath(import.meta.url));
const distUi = path.resolve(here, '..', '..', 'dist-ui');
const outDir = path.resolve(here, '..', '..', '..', 'docs', 'screenshots');

test.use({ viewport: { width: 1440, height: 900 } });
test.skip(!SHOTS, 'set SHOTS=1 to capture validation screenshots');
test.beforeAll(() => { mkdirSync(outDir, { recursive: true }); });

const PAIRING: PairingImport = {
  collectorId: '11111111-2222-4333-8444-555555555555',
  host: '192.168.1.50',
  ingestPort: 8788,
  atlantisPort: 10909,
  certificateDerBase64: Buffer.from('example-collector-fake-der').toString('base64'),
  certificateSha256: 'ab'.repeat(32),
  deviceToken: 'device-token-abcdef012345',
};

const HOSTS = ['api.example.com', 'tiles.example.com', 'auth.example.com', 'ws.example.com'];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
// Realistic status mix, incl. a transport error (null status + error string).
const STATUSES: { status: number | null; error: string | null }[] = [
  { status: 200, error: null }, { status: 201, error: null }, { status: 204, error: null },
  { status: 301, error: null }, { status: 401, error: null }, { status: 404, error: null },
  { status: 500, error: null }, { status: null, error: 'network' },
];

function entryInput(over: Record<string, unknown>) {
  return {
    id: 'x', deviceId: 'dev-01', source: 'atlantis' as const, startedAt: 1, method: 'GET', url: 'https://api.example.com/',
    requestHeaders: {}, requestBytes: null, requestBodySize: 0, requestBodyOmitted: null,
    status: 200, statusText: 'OK', responseHeaders: {}, responseBytes: null, responseBodySize: 0,
    responseBodyOmitted: null, durationMs: 10, error: null, ...over,
  };
}

// Seed ~40 HTTP entries across four hosts and the full status mix, three devices,
// and three socket streams (a live WS with frames, an SSE stream, a closed WS).
function seed(h: CollectorHarness): void {
  // Three devices (ios/android, mixed profiles/versions).
  h.store.applyDeviceMessage('dev-01', { type: 'hello', deviceId: 'dev-01', platform: 'ios', appVersion: '3.4.1', buildProfile: 'qa', dropped: 0, ts: Date.now() });
  h.store.applyDeviceMessage('dev-02', { type: 'hello', deviceId: 'dev-02', platform: 'android', appVersion: '3.4.0', buildProfile: 'release', dropped: 3, ts: Date.now() - 12_000 });
  h.store.applyDeviceMessage('dev-03', { type: 'hello', deviceId: 'dev-03', platform: 'ios', appVersion: '3.5.0', buildProfile: 'debug', dropped: 0, ts: Date.now() - 90_000 });

  // A featured entry with a real JSON response body: the row selected in
  // 01-capture-main so the Response tab pretty-prints and Headers/Timing populate.
  const json = JSON.stringify({ ok: true, user: { id: 'u_8842', plan: 'pro' }, items: [1, 2, 3], nextCursor: 'c_19f' }, null, 0);
  h.store.addEntryInput(entryInput({
    id: 'sel-1', deviceId: 'dev-01', startedAt: 10_000, method: 'GET', url: 'https://api.example.com/v1/session/current',
    requestHeaders: { authorization: 'Bearer ***redacted***', accept: 'application/json' },
    status: 200, statusText: 'OK', responseHeaders: { 'content-type': 'application/json', 'x-request-id': 'req_7f31a9', 'cache-control': 'no-store' },
    responseBytes: new Uint8Array(Buffer.from(json)), responseBodySize: json.length, durationMs: 128,
  }) as never);

  // Per-host config so path and content-type always match the host: the tiles CDN
  // serves image/png tiles only, the other hosts serve JSON. Host cycles on i mod 4
  // and method on i mod 3 — coprime periods, so a host is NOT locked to one method
  // (no constant-offset correlation); status walks a separate stride. Every row
  // carries a REAL response body of non-zero length, so the size column reads honest
  // byte counts (never 0 B) and the bytes are downloadable.
  const HOST_CFG: Record<string, { paths: string[]; contentType: string; binary: boolean }> = {
    'api.example.com': { paths: ['v1/users', 'v1/orders', 'v1/search', 'v1/events'], contentType: 'application/json', binary: false },
    'tiles.example.com': { paths: ['tiles/12/34', 'tiles/8/21', 'tiles/3/9'], contentType: 'image/png', binary: true },
    'auth.example.com': { paths: ['v1/token', 'v1/session', 'v1/refresh'], contentType: 'application/json', binary: false },
    'ws.example.com': { paths: ['v1/live', 'v1/notify'], contentType: 'application/json', binary: false },
  };
  let ts = 1_000;
  for (let i = 0; i < 40; i++) {
    const host = HOSTS[i % HOSTS.length];
    const cfg = HOST_CFG[host];
    const method = METHODS[i % 3];
    const s = STATUSES[(i * 5 + 3) % STATUSES.length];
    // Cycle paths by the per-host visit index (i / HOSTS.length), NOT a stride on i:
    // since host repeats every HOSTS.length, a stride on i would pin each host to a
    // single path. This walks every host through all its paths (so e.g. the api host
    // still emits an `orders` row the palette shot searches for).
    const path = cfg.paths[Math.floor(i / HOSTS.length) % cfg.paths.length];
    const device = `dev-0${((i * 2 + 1) % 3) + 1}`;
    // A deterministic, per-row body of varying length (always ≥ 1 byte).
    const body = cfg.binary
      ? Uint8Array.from({ length: 200 + ((i * 61 + 7) % 3400) }, (_v, k) => (i * 31 + k * 17) & 0xff)
      : new Uint8Array(Buffer.from(JSON.stringify({ ok: s.status != null && s.status < 400, seq: i, host, note: 'n'.repeat(1 + ((i * 13) % 48)) })));
    h.store.addEntryInput(entryInput({
      id: `e-${i}`, deviceId: device, startedAt: ts++, method,
      url: `https://${host}/${path}?p=${i}`,
      status: s.status, statusText: s.status === 200 ? 'OK' : '', error: s.error,
      responseHeaders: { 'content-type': cfg.contentType },
      responseBytes: body, responseBodySize: body.byteLength, durationMs: 12 + ((i * 89 + 17) % 880),
    }) as never);
  }

  // Live WS with frames (one JSON frame is expanded in 02-sockets), an SSE stream,
  // and a closed WS.
  h.store.addWsSession({ wsId: 'ws-live', deviceId: 'dev-01', source: 'xhr', url: 'wss://ws.example.com/v1/live', openedAt: 500, frames: [], closedAt: null, closeCode: null, closeReason: '' });
  const frames = [
    '{"type":"hello","proto":2}', '{"type":"subscribe","channel":"orders"}',
    '{"type":"tick","seq":41,"px":128.44}', '{"type":"tick","seq":42,"px":128.51}',
    '{"type":"ack","seq":42}', '{"type":"tick","seq":43,"px":128.39}',
  ];
  frames.forEach((data, i) => h.store.appendWsFrame('ws-live', { ts: 600 + i, direction: i % 3 === 1 ? 'out' : 'in', data, size: data.length, binary: false }));

  h.store.addWsSession({ wsId: 'sse-events', deviceId: 'dev-02', source: 'xhr', kind: 'sse', url: 'https://api.example.com/v1/events', openedAt: 400, frames: [], closedAt: null, closeCode: null, closeReason: '' });
  h.store.appendWsFrame('sse-events', { ts: 450, direction: 'in', data: 'event: ping\ndata: {"t":1}', size: 24, binary: false });

  h.store.addWsSession({ wsId: 'ws-closed', deviceId: 'dev-03', source: 'xhr', url: 'wss://ws.example.com/v1/notify', openedAt: 200, frames: [], closedAt: 900, closeCode: 1000, closeReason: 'normal' });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(outDir, name) });
}

async function login(page: Page, h: CollectorHarness): Promise<void> {
  await page.goto(`${h.url}/#token=${h.adminToken}`);
  await expect(page.getByTestId('capture-connection')).toHaveText('Conectado');
}

test('capture, sockets, devices, paused and palette screenshots', async ({ page }) => {
  const h = await createCollectorHarness({ uiDir: distUi, getPairing: () => PAIRING });
  try {
    seed(h);
    await login(page, h);
    await expect(page.getByTestId('entry-row-sel-1')).toBeVisible();

    // 01 — Capture main, row selected, Response tab (default) pretty JSON.
    await page.getByTestId('entry-row-sel-1').click();
    await expect(page.getByTestId('body-response')).toContainText('"ok": true');
    await shot(page, '01-capture-main.png');

    // 01b — Headers tab.
    await page.getByTestId('detail-panel').getByRole('tab', { name: 'Headers' }).click();
    await expect(page.getByText('x-request-id')).toBeVisible();
    await shot(page, '01b-capture-headers.png');

    // 01c — Timing tab.
    await page.getByTestId('detail-panel').getByRole('tab', { name: 'Timing' }).click();
    await expect(page.getByText('Phase breakdown not available from this source')).toBeVisible();
    await shot(page, '01c-capture-timing.png');

    // 02 — Sockets, session selected, one frame expanded.
    await page.getByRole('button', { name: 'Sockets' }).click();
    await page.getByTestId('ws-row-ws-live').click();
    await page.getByTestId('ws-frame-2').click();
    await expect(page.getByTestId('frame-body-text')).toContainText('"type":"tick"');
    await shot(page, '02-sockets.png');

    // 03 — Devices grid + pairing + retention.
    await page.getByRole('button', { name: 'Devices', exact: true }).click();
    await expect(page.getByTestId('device-card').first()).toBeVisible();
    await expect(page.getByText(`${PAIRING.host}:${PAIRING.ingestPort}`)).toBeVisible();
    await shot(page, '03-devices.png');

    // 05 — Command palette open with a query (from the Capture tab).
    await page.getByRole('button', { name: 'Capture' }).click();
    await expect(page.getByTestId('entry-row-sel-1')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await palette.getByRole('combobox', { name: 'Search commands' }).fill('orders');
    // Wait out the query debounce: the list is filtered once the top result
    // reflects the typed query (no fixed sleep).
    await expect(palette.getByRole('option').first()).toContainText('orders');
    await shot(page, '05-palette.png');
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    // 04d — Paused: pill + amber table header border.
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByTestId('paused-pill')).toBeVisible();
    await shot(page, '04d-paused.png');
  } finally {
    await h.close();
  }
});

test('empty-store screenshot', async ({ page }) => {
  const h = await createCollectorHarness({ uiDir: distUi });
  try {
    await login(page, h);
    // Empty store → the capture view shows its waiting-for-device empty state.
    await expect(page.getByText('Aguardando device…')).toBeVisible();
    await shot(page, '04b-empty.png');
  } finally {
    await h.close();
  }
});

test('login screenshot', async ({ page }) => {
  const h = await createCollectorHarness({ uiDir: distUi });
  try {
    // No token fragment and no cookie → the login screen.
    await page.goto(`${h.url}/`);
    await expect(page.getByLabel('Admin token')).toBeVisible();
    await expect(page.getByText('Cole o admin token impresso no terminal')).toBeVisible();
    await shot(page, '04a-login.png');
  } finally {
    await h.close();
  }
});

test('reconnecting screenshot', async ({ page }) => {
  // Intercept the /ui socket: let the FIRST connection through (snapshot + data
  // flow, so the shell is populated), then drop it. HTTP stays up, so probeSession
  // answers 200 and the client holds `reconnecting` (every reopen is closed again)
  // — the banner sits over the still-populated, dimmed content.
  const h = await createCollectorHarness({ uiDir: distUi, getPairing: () => PAIRING });
  let attempt = 0;
  let firstWs: import('@playwright/test').WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ui(\?|$)/, (ws) => {
    attempt += 1;
    if (attempt === 1) {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(m));
      firstWs = ws;
    } else {
      ws.close();
    }
  });
  try {
    seed(h);
    await login(page, h);
    await expect(page.getByTestId('entry-row-sel-1')).toBeVisible();

    // Drop the live socket; the client flaps into a steady reconnecting state.
    await expect.poll(() => firstWs !== null).toBeTruthy();
    await firstWs!.close();
    await expect(page.getByText(/Reconectando ao collector/)).toBeVisible();
    await shot(page, '04c-reconnecting.png');
  } finally {
    await h.close();
  }
});
