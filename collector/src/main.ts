import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { createHttpServer } from './http.js';
import { createUiAuth } from './security/uiAuth.js';
import { loadOrCreateIdentity, toPairingImport, defaultStateDir, migrateLegacyStateDir, acquireStateLock, lanAddresses, pairingHost, pairingHostWarning, logPairingHostDrift } from './security/identity.js';
import { writeAdminTokenFile, removeAdminTokenFile } from './security/adminToken.js';
import { createCertServer } from './security/certServer.js';
import { createDeviceServer, createIngestShared } from './deviceServer.js';
import { startAtlantisServer, startLegacyLoopback } from './atlantis/server.js';
import { createProxySource, loadOrCreateProxyCA, type ProxySource } from './proxy/server.js';
import { startDiscovery } from './discovery.js';
import { VERSION } from './version.js';
import { log } from './log.js';
import { env, envName } from './env.js';

function port(name: string, def: number): number {
  return checkPort(name, process.env[name], def);
}
// Validate an already-read port value (raw string) against a label used only for
// the error message. Shared by the bare PORT/INGEST/ATLANTIS reads and the
// TERMINUS_-prefixed proxy port that comes through the env() fallback helper.
function checkPort(label: string, raw: string | undefined, def: number): number {
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) { log.error(`invalid ${label}: ${raw}`); process.exit(1); }
  return n;
}
const HTTP_PORT = port('PORT', 8787);
const INGEST_PORT = port('INGEST_PORT', 8788);
const ATLANTIS_PORT = port('ATLANTIS_PORT', 10909);
// The public cert listener (QR pairing) binds the LAN like the TLS ingest. It uses
// the TERMINUS_/NETCAPTURE_ fallback like the proxy port, not a bare env read.
const CERT_PORT = checkPort(envName('CERT_PORT'), env('CERT_PORT'), 8789);

// Admin credential: 32 random bytes, distinct from the persisted device token and
// regenerated every start, so a restart invalidates outstanding UI sessions and
// old login links while keeping the device pairing intact.
const adminToken = randomBytes(32).toString('base64url');

// The old plaintext passcode was sent in the clear; it is never reused as a v2
// credential. Point the operator at the pairing flow instead.
const passcodeVar = process.env.NETCAPTURE_PASSCODE ? 'NETCAPTURE_PASSCODE'
  : process.env.TERMINUS_PASSCODE ? 'TERMINUS_PASSCODE' : null;
if (passcodeVar) {
  log.warn(`${passcodeVar} is no longer used. Capture ingests now require the TLS device token; copy the pairing from the authenticated UI (GET /api/pairing). Unset ${passcodeVar}.`);
}

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist-ui');

// A crash in one handler must not take the whole collector down mid-session.
process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

async function boot() {
  const host = os.hostname().replace(/\.local$/, '');
  const stateDir = defaultStateDir();
  // One-time rename of a pre-Terminus state dir, before the lock is taken.
  await migrateLegacyStateDir(stateDir);
  // Hold the state-dir lock while running so `identity:rotate` refuses to race us.
  const releaseLock = await acquireStateLock(stateDir);
  // Publish this boot's admin token (0600, atomic) so a same-machine CLI can
  // authenticate without the operator copying a token; removed by shutdown().
  writeAdminTokenFile(adminToken, stateDir);

  // Listeners are assigned as each starts; shutdown() closes whatever exists and
  // always removes the admin-token file, then exits. One path for every stop:
  // SIGINT, SIGTERM, a fatal HTTP bind error, and a boot failure after the token
  // was written. A second signal exits immediately.
  let httpHandle: ReturnType<typeof createHttpServer> | null = null;
  let certServer: ReturnType<typeof createCertServer> | null = null;
  let device: ReturnType<typeof createDeviceServer> | null = null;
  let atlantis: ReturnType<typeof startAtlantisServer> | null = null;
  let legacy: ReturnType<typeof startLegacyLoopback> | null = null;
  let proxy: ProxySource | null = null;
  let discovery: ReturnType<typeof startDiscovery> | null = null;
  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) { process.exit(code); return; }
    shuttingDown = true;
    log.info('shutting down…');
    const timer = setTimeout(() => process.exit(code), 2000); // hard backstop
    timer.unref?.();
    removeAdminTokenFile(stateDir);
    try { httpHandle?.close(); } catch (e) { log.warn('http close failed', String(e)); }
    try { certServer?.close(); } catch (e) { log.warn('cert close failed', String(e)); }
    try { device?.close(); } catch (e) { log.warn('device close failed', String(e)); }
    try { atlantis?.close(); } catch (e) { log.warn('atlantis close failed', String(e)); }
    try { legacy?.close(); } catch { /* not started */ }
    void proxy?.stop();
    void releaseLock();
    if (discovery) discovery.stop(() => process.exit(code));
    else process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  try {
    log.info(`terminus collector v${VERSION}`);
    const identity = await loadOrCreateIdentity(stateDir, { host, ingestPort: INGEST_PORT, atlantisPort: ATLANTIS_PORT });
    log.info(`collector identity ${identity.collectorId} (generation ${identity.generation}), cert sha256 ${identity.certificateSha256}`);
    // Boot drift check: if no current LAN IPv4 is in the cert SAN, devices that dial
    // the advertised host will fail the SAN check. Warn once (never auto-rotate —
    // rotation invalidates every existing pairing); the same guard covers the
    // per-request pairingHost fallback so this logs a single time.
    logPairingHostDrift(identity, env);
    log.info(`advertising pairing host ${pairingHost(identity, env)}`);

    const store = new Store();
    const uiAuth = createUiAuth({ adminToken });
    // Shared ingest machinery (budget, scheduler, connection slots) across both LAN
    // capture channels. Built before the HTTP server so GET /api/status can report
    // its live scheduler stats and connected-device count.
    const shared = createIngestShared();
    // certPort is echoed additively on GET /api/pairing so the UI can mint the QR's
    // QrPairing; it is the LAN cert listener's port, where the app fetches the DER.
    httpHandle = createHttpServer(store, uiDir, {
      uiAuth,
      getPairing: () => toPairingImport(identity, pairingHost(identity, env)),
      getPairingWarning: () => pairingHostWarning(identity, env),
      certPort: CERT_PORT,
      ingest: shared,
    });
    httpHandle.server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') log.error(`port ${HTTP_PORT} already in use; set PORT to another value`);
      else log.error('http server error', e);
      shutdown(1);
    });
    // UI, /api/*, exports and /ui bind loopback only.
    httpHandle.server.listen(HTTP_PORT, '127.0.0.1', () => {
      log.info(`listening on http://127.0.0.1:${HTTP_PORT} (loopback only)`);
      log.info(`open http://127.0.0.1:${HTTP_PORT}/#token=${adminToken}`);
    });

    device = createDeviceServer(store, identity, shared);
    device.server.on('error', (e: NodeJS.ErrnoException) => log.error('device server error', e));
    device.server.listen(INGEST_PORT, '0.0.0.0', () => log.info(`wss ingest listening on ${INGEST_PORT} (tls)`));

    atlantis = startAtlantisServer(store, ATLANTIS_PORT, { identity, shared });
    discovery = startDiscovery({ ingestPort: INGEST_PORT, atlantisPort: ATLANTIS_PORT, collectorId: identity.collectorId, host });

    // Public cert listener for QR pairing: plain HTTP on the LAN (same interface as
    // the TLS ingest), serving only the public certificate so a paired device can
    // fetch and verify it. Additive; a bind failure never takes capture down.
    certServer = createCertServer({ identity, port: CERT_PORT });
    certServer.server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') log.error(`cert port ${CERT_PORT} already in use; set TERMINUS_CERT_PORT to another value`);
      else log.error('cert server error', e);
    });
    certServer.listen(() => {
      // The listener binds 0.0.0.0; advertise the same host the QR/pairing carries so
      // the device fetches /api/cert from an address its SAN check will accept.
      log.info(`cert endpoint http://${pairingHost(identity, env)}:${CERT_PORT}/api/cert`);
    });

    if (env('ALLOW_LEGACY_LOOPBACK') === '1') {
      legacy = startLegacyLoopback(store, 10910);
    }

    // Additive proxy source (R4/T11). OFF by default; TERMINUS_PROXY=1 turns it on
    // for a QA device. It NEVER gates Atlantis or the WSS ingest — those started
    // above unconditionally — so proxy evidence is added alongside, never in place of,
    // the app-side capture. The client allowlist (device IPs) is explicit and required:
    // an empty allowlist rejects every client, so there is no open relay on the LAN.
    if (env('PROXY') === '1') {
      const allow = (env('PROXY_ALLOW') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const proxyPort = checkPort(envName('PROXY_PORT'), env('PROXY_PORT'), 8080);
      // Every collector-internal endpoint is tunnelled without inspection so device
      // tokens/auth headers never enter the proxy store and the collector's pinned
      // certificate is never replaced by a proxy-signed one. A device dials the
      // collector by hostname OR by one of its LAN IPs (the cert's SAN targets), so
      // every one of those addresses must be excluded — not just the hostname/loopback.
      const collectorHosts = [...new Set([host, 'localhost', ...lanAddresses()])];
      const internal = [INGEST_PORT, ATLANTIS_PORT, HTTP_PORT].flatMap((p) =>
        collectorHosts.map((h) => ({ host: h, port: p })));
      const ca = await loadOrCreateProxyCA(path.join(stateDir, 'proxy-ca'));
      proxy = createProxySource({ port: proxyPort, ca, store, excludedCollectorEndpoints: internal, deviceAllowlist: allow });
      await proxy.start();
      log.info(`proxy CA (copy to QA device, trust as user CA): ${ca.certPath}`);
      if (allow.length === 0) log.warn('proxy: TERMINUS_PROXY_ALLOW is empty; every client will be rejected. Set it to the QA device IP(s).');
    }
  } catch (e) {
    // A failure after the token was written must still clean it up and release the
    // lock — route through the same shutdown path rather than a bare exit.
    log.error('failed to start collector:', e instanceof Error ? e.message : e);
    shutdown(1);
  }
}

// A failure before the token/shutdown are set up (migrate, lock) has nothing to
// clean up; exit non-zero.
boot().catch((e) => { log.error('failed to start collector:', e instanceof Error ? e.message : e); process.exit(1); });
