import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { Store } from '../../src/store.js';
import { createHttpServer } from '../../src/http.js';
import { createUiAuth } from '../../src/security/uiAuth.js';
import type { Page, EntrySummary, WsSummary, UiDevice } from '../../src/uiProtocol.js';

// The authenticated snapshot the UI would rebuild from on reconnect, assembled
// over the paginated HTTP metadata endpoints: first page of each list plus the
// retention totals. Bodies are never present here — only BodyRefs — so a test
// can assert the snapshot never carries body text.
export type HarnessSnapshot = {
  devices: Page<UiDevice>;
  entries: Page<EntrySummary>;
  ws: Page<WsSummary>;
  retention: unknown;
};

export interface CollectorHarness {
  url: string;
  origin: string;
  store: Store;
  adminToken: string;
  // Exchange the admin bearer for a session and return the `nc_session=…` cookie
  // string, ready to pass as a `cookie` header from Node tests.
  login(): Promise<string>;
  // Authenticated paginated snapshot (devices + entry/ws summaries + retention).
  snapshot(): Promise<HarnessSnapshot>;
  // Authenticated body fetch for one entry side; returns the decoded text (empty
  // string for an absent/empty body). Throws on a 404 (missing) or 410 (omitted).
  getEntryBody(key: { deviceId: string; id: string; side: 'request' | 'response' }): Promise<string>;
  close(): Promise<void>;
}

// Spin up an authenticated collector on an ephemeral loopback port. Every listener
// is bound to 127.0.0.1 and torn down by close(); callers must await close() in a
// finally/afterEach so no socket leaks between tests.
export async function createCollectorHarness(
  opts: { adminToken?: string; uiDir?: string; now?: () => number; certPort?: number; getPairing?: () => import('../../src/security/types.js').PairingImport | null } = {},
): Promise<CollectorHarness> {
  const adminToken = opts.adminToken ?? randomBytes(32).toString('base64url');
  const uiDir = opts.uiDir ?? '/nonexistent-ui';
  const store = new Store();
  const uiAuth = createUiAuth({ adminToken, now: opts.now });
  const handle = createHttpServer(store, uiDir, { uiAuth, getPairing: opts.getPairing, certPort: opts.certPort });

  await new Promise<void>((r) => handle.server.listen(0, '127.0.0.1', () => r()));
  const port = (handle.server.address() as net.AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const origin = url;

  let cookie: string | null = null;
  const login = async () => {
    const res = await fetch(url + '/api/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, origin },
    });
    if (res.status !== 204) throw new Error(`login failed: ${res.status}`);
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) throw new Error('login returned no Set-Cookie');
    cookie = setCookie.split(';')[0];
    return cookie;
  };
  const auth = async () => cookie ?? (await login());

  return {
    url,
    origin,
    store,
    adminToken,
    login,
    async snapshot() {
      const c = await auth();
      const get = async (p: string) => {
        const r = await fetch(url + p, { headers: { cookie: c } });
        if (r.status !== 200) throw new Error(`${p} -> ${r.status}`);
        return r.json();
      };
      const [devices, entries, ws] = await Promise.all([get('/api/devices'), get('/api/entries'), get('/api/ws')]);
      return { devices, entries, ws, retention: store.retentionCounters() };
    },
    async getEntryBody({ deviceId, id, side }) {
      const c = await auth();
      const r = await fetch(`${url}/api/entries/${encodeURIComponent(deviceId)}/${encodeURIComponent(id)}/body?side=${side}`, { headers: { cookie: c } });
      if (r.status !== 200) throw new Error(`body ${deviceId}/${id}/${side} -> ${r.status}`);
      return r.text();
    },
    async close() {
      handle.close();
      await new Promise<void>((r) => handle.server.close(() => r()));
    },
  };
}
