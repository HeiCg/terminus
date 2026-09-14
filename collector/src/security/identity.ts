import { execFile } from 'node:child_process';
import tls from 'node:tls';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, createHash, X509Certificate } from 'node:crypto';
import type { CollectorIdentity, PublicPairing, PairingImport } from './types.js';
import { isHostname, isIp } from './types.js';
import { log } from '../log.js';
import { env, envName } from '../env.js';

const exec = promisify(execFile);

export const DEFAULT_INGEST_PORT = 8788;
export const DEFAULT_ATLANTIS_PORT = 10909;

// Persisted layout inside the state dir. The private key and device token are the
// only 0600 secrets; identity.json/cert.pem are non-secret but stay 0600 too so
// the whole dir is uniform.
const F_META = 'identity.json';
const F_CERT = 'cert.pem';
const F_KEY = 'key.pem';
const F_TOKEN = 'device-token';

// The per-OS state-dir resolver lives in stateDir.ts (crypto-free so the CLI can
// import it without pulling in this module's TLS/crypto surface). Imported for this
// module's own use and re-exported because the collector's callers import it here.
import { defaultStateDir } from './stateDir.js';
export { defaultStateDir };

// The pre-rename state dir. A collector that ran as argo-netcapture wrote its
// identity, cert, device token and proxy CA here; migration moves the whole dir so
// existing pairings survive the rename. This only ever existed on macOS (the old
// build was macOS-only), so it is the macOS Application Support path.
export function legacyStateDir(): string {
  const home = process.env.HOME || os.homedir();
  return path.join(home, 'Library', 'Application Support', 'ArgoNetCapture');
}

// Move the legacy ArgoNetCapture state dir to the new Terminus location, once, on
// startup and before the state lock is taken. A single `fs.rename` keeps identity,
// cert, device token and proxy-ca together so paired devices stay paired.
//
// "Already migrated" is decided by identity.json inside the new dir, not by the
// dir merely existing: an empty Terminus dir left by a partial run must still
// trigger the rename (we rmdir it first so the one-move rename can proceed). If a
// populated new dir already exists we touch neither and warn about the stale
// legacy dir. An explicit state-dir override (env or CLI) opts out entirely.
//
// Migration never blocks boot: a rename that loses a race (ENOENT/EEXIST/ENOTEMPTY)
// is treated as already migrated; any other failure (EXDEV across volumes, EPERM)
// is logged and we continue with a fresh state dir rather than throwing.
export async function migrateLegacyStateDir(
  newDir: string,
  legacyDir = legacyStateDir(),
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  // argo-netcapture only ever ran on macOS, so there is nothing to migrate elsewhere.
  if (platform !== 'darwin') return;
  const override = env('STATE_DIR');
  if (override && override.trim() !== '') return;
  if (!fs.existsSync(legacyDir)) return;
  if (fs.existsSync(path.join(newDir, F_META))) {
    log.warn(`legacy state dir ${legacyDir} still exists alongside ${newDir}; leaving it untouched. Remove it once you have confirmed the new dir.`);
    return;
  }
  try {
    // An empty new dir would make rename fail with EEXIST/ENOTEMPTY; clear it first.
    if (fs.existsSync(newDir)) await fsp.rmdir(newDir);
    await fsp.mkdir(path.dirname(newDir), { recursive: true });
    await fsp.rename(legacyDir, newDir);
    log.info(`migrated state dir from ArgoNetCapture to ${newDir}`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') {
      log.info(`state dir already migrated to ${newDir} (${code}); continuing`);
      return;
    }
    log.warn(`could not migrate legacy state dir ${legacyDir} (${code ?? e}); continuing with a fresh state dir at ${newDir}`);
  }
}

// Fail before opening any listener if OpenSSL 3+ is unavailable; the message names
// the fix rather than surfacing a raw ENOENT deep in cert generation.
export async function ensureOpenSSL(): Promise<void> {
  let out: string;
  try { out = (await exec('openssl', ['version'])).stdout; }
  catch { throw new Error('OpenSSL 3 not found on PATH. Install it (e.g. `brew install openssl@3`) before starting the collector.'); }
  const m = /OpenSSL\s+(\d+)\./.exec(out);
  if (!m || Number(m[1]) < 3) throw new Error(`OpenSSL 3 required, found: ${out.trim()}`);
}

// LAN IPv4/IPv6 the cert should be valid for, plus the loopback anchors. Filtered
// to the addresses the device is likely to dial.
export function lanAddresses(): string[] {
  const ips = new Set<string>(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) if (!nic.internal) ips.add(nic.address.replace(/%.*$/, ''));
  }
  return [...ips];
}

// Reject anything that is not a plain hostname or IP before it reaches the openssl
// argv; SAN values are attacker-influenced when they come from a rotate CLI.
// isHostname/isIp live in types.js (shared with isQrPairing's host check).
export function validateSanTargets(host: string, ips: string[]): void {
  if (!isHostname(host)) throw new Error(`invalid host: ${JSON.stringify(host)}`);
  for (const ip of ips) if (!isIp(ip)) throw new Error(`invalid ip: ${JSON.stringify(ip)}`);
}

// Build the openssl subjectAltName argument, classifying each target: an IP host
// goes as `IP:` and a name host as `DNS:` (before this, `--host <ip>` produced a
// bogus `DNS:<ip>` entry no client verifies against). `localhost` is always a DNS
// name; the caller's `ips` are already IPs. An IP host duplicated in `ips` is emitted
// once. IPv6 loopback/link-local exclusion is unchanged — it is governed by what
// `lanAddresses()` collects, not by this classifier.
export function sanArg(host: string, ips: string[]): string {
  const names: string[] = [];
  const ipList: string[] = [...ips];
  if (isIp(host)) { if (!ipList.includes(host)) ipList.unshift(host); }
  else names.push(host);
  if (!names.includes('localhost')) names.push('localhost');
  const parts = names.map((d) => `DNS:${d}`).concat(ipList.map((ip) => `IP:${ip}`));
  return `subjectAltName=${parts.join(',')}`;
}

function derSha256(pem: string): { der: string; sha256: string } {
  const cert = new X509Certificate(pem);
  const der = cert.raw;
  return { der: der.toString('base64'), sha256: createHash('sha256').update(der).digest('hex') };
}

// atomic-write a file: write a sibling temp then rename, so a crash mid-write never
// leaves a half-identity that would be trusted on the next boot.
async function atomicWrite(dir: string, name: string, data: string | Buffer, mode: number): Promise<void> {
  const tmp = path.join(dir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fh = await fsp.open(tmp, 'wx', mode);
  try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
  await fsp.chmod(tmp, mode);
  await fsp.rename(tmp, path.join(dir, name));
}

const F_LOCK = 'state.lock';
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

// Exclusive lock on the state dir. The running collector holds it; `identity:rotate`
// refuses while it is held so a rotation never races a live listener. A lock left by
// a dead process is treated as stale and reclaimed.
export async function acquireStateLock(stateDir: string): Promise<() => Promise<void>> {
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, F_LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fsp.open(lockPath, 'wx', 0o600);
      await fh.writeFile(String(process.pid)); await fh.close();
      return async () => { await fsp.rm(lockPath, { force: true }); };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number((await fsp.readFile(lockPath, 'utf8').catch(() => '')).trim());
      if (pid && pidAlive(pid)) throw new Error(`state dir ${stateDir} is locked by a running collector (pid ${pid}); stop it before rotating.`);
      await fsp.rm(lockPath, { force: true }); // stale lock, retry once
    }
  }
  throw new Error(`could not acquire state lock at ${stateDir}`);
}

// Current generation from the persisted meta, or 0 if none.
export async function currentGeneration(stateDir: string): Promise<number> {
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(stateDir, F_META), 'utf8'));
    return typeof meta.generation === 'number' ? meta.generation : 0;
  } catch { return 0; }
}

export type GenerateOpts = {
  host?: string;
  ips?: string[];
  days?: number;
  keyBits?: number;   // fixtures may drop to 2048 for speed; production is 3072
};

// Generate an RSA-3072/SHA-256 self-signed serverAuth certificate + key into
// `dir` using OpenSSL via execFile (argv array, never a shell string). Returns the
// PEMs; callers persist them atomically.
export async function generateCertificate(dir: string, opts: GenerateOpts = {}): Promise<{ certPem: string; keyPem: string }> {
  const host = opts.host ?? os.hostname().replace(/\.local$/, '');
  const ips = opts.ips ?? lanAddresses();
  validateSanTargets(host, ips);
  const keyBits = opts.keyBits ?? 3072;
  const keyOut = path.join(dir, `.key.${process.pid}.${randomBytes(4).toString('hex')}.pem`);
  const certOut = path.join(dir, `.cert.${process.pid}.${randomBytes(4).toString('hex')}.pem`);
  const args = [
    'req', '-x509', '-newkey', `rsa:${keyBits}`, '-sha256', '-nodes',
    '-keyout', keyOut, '-out', certOut, '-subj', `/CN=${host}`,
    '-addext', sanArg(host, ips),
    '-addext', 'extendedKeyUsage=serverAuth',
    '-addext', 'keyUsage=digitalSignature,keyEncipherment',
  ];
  args.push('-days', String(opts.days ?? 365));
  try {
    await exec('openssl', args, { maxBuffer: 8 * 1024 * 1024 });
    const certPem = await fsp.readFile(certOut, 'utf8');
    const keyPem = await fsp.readFile(keyOut, 'utf8');
    return { certPem, keyPem };
  } finally {
    await fsp.rm(keyOut, { force: true });
    await fsp.rm(certOut, { force: true });
  }
}

function buildIdentity(
  meta: { collectorId: string; host: string; generation: number },
  certPem: string, keyPem: string, deviceToken: string,
  ports: { ingestPort: number; atlantisPort: number },
): CollectorIdentity {
  const cert = new X509Certificate(certPem);
  const { der, sha256 } = derSha256(certPem);
  const publicPairing: PublicPairing = {
    version: 2, collectorId: meta.collectorId, host: meta.host,
    ingestPort: ports.ingestPort, atlantisPort: ports.atlantisPort,
    certificateDerBase64: der, certificateSha256: sha256,
  };
  return {
    collectorId: meta.collectorId, host: meta.host, generation: meta.generation,
    certificatePem: certPem, privateKeyPem: keyPem,
    certificateDerBase64: der, certificateSha256: sha256, deviceToken,
    notBefore: Date.parse(cert.validFrom), notAfter: Date.parse(cert.validTo),
    ingestPort: ports.ingestPort, atlantisPort: ports.atlantisPort, publicPairing,
  };
}

// The `IP Address:` entries of the cert's subjectAltName. The connecting device's
// SAN check passes when it dials one of these, so these are the addresses safe to
// advertise. DNS names in the SAN are ignored here — phones cannot resolve the
// Mac's hostname (no mDNS in Android fetch), which is the whole reason the advertised
// host must be an IP.
export function certSanIps(certPem: string): string[] {
  if (!certPem) return [];
  let san: string | undefined;
  try { san = new X509Certificate(certPem).subjectAltName ?? undefined; } catch { return []; }
  if (!san) return [];
  const ips: string[] = [];
  for (const part of san.split(',')) {
    const m = /^\s*IP Address:(.+?)\s*$/.exec(part);
    if (m) ips.push(m[1]);
  }
  return ips;
}

// LAN IPv4s a device could actually dial: drop loopback and every IPv6 form.
function lanIpv4(lan: () => string[]): string[] {
  return lan().filter((ip) => ip.includes('.') && !ip.includes(':') && ip !== '127.0.0.1');
}

// A validated TERMINUS_PAIRING_HOST override (hostname or IP), or null. An invalid
// value is ignored — with a single warning — so a typo falls through to LAN
// detection rather than advertising something no device can reach.
let invalidOverrideWarned = false;
function pairingHostOverride(e: typeof env): string | null {
  const raw = e('PAIRING_HOST');
  if (raw == null || raw.trim() === '') return null;
  const h = raw.trim();
  if (isHostname(h) || isIp(h)) return h;
  if (!invalidOverrideWarned) {
    invalidOverrideWarned = true;
    log.warn(`ignoring ${envName('PAIRING_HOST')}=${JSON.stringify(h)}: not a valid hostname or IP; falling back to the LAN IPv4`);
  }
  return null;
}

// The host to advertise for pairing (the QR, /api/pairing, `terminus pair`, the cert
// endpoint log). Resolved at runtime, not from identity meta:
//   1. TERMINUS_PAIRING_HOST when set and valid;
//   2. else the first current LAN IPv4 that is in the cert SAN (so the device's SAN
//      check passes when it dials it);
//   3. else identity meta.host, warning once about the drift.
// `e`/`lan` are injectable so tests do not depend on the machine's real interfaces.
export function pairingHost(id: CollectorIdentity, e: typeof env = env, lan: () => string[] = lanAddresses): string {
  const override = pairingHostOverride(e);
  if (override) return override;
  const sanIps = new Set(certSanIps(id.certificatePem));
  const match = lanIpv4(lan).find((ip) => sanIps.has(ip));
  if (match) return match;
  logPairingHostDrift(id, e, lan);
  return id.host;
}

// The drift warning string, or null when a LAN IPv4 is covered (or an override pins
// the host). Pure — no logging — so /api/pairing can surface it to the CLI.
export function pairingHostWarning(id: CollectorIdentity, e: typeof env = env, lan: () => string[] = lanAddresses): string | null {
  if (pairingHostOverride(e)) return null;
  const sanIps = new Set(certSanIps(id.certificatePem));
  if (lanIpv4(lan).some((ip) => sanIps.has(ip))) return null;
  const has = sanIps.size ? [...sanIps].join(', ') : 'no IP entries';
  return `no current LAN IPv4 is in the certificate SAN (cert has ${has}); devices may fail to connect; run \`npm run identity:rotate\` to regenerate`;
}

// Log the drift warning at most once per certificate (keyed by digest), so the boot
// check and the per-request pairingHost fallback together warn a single time. Never
// auto-rotates: rotation invalidates every existing pairing.
const driftWarned = new Set<string>();
export function logPairingHostDrift(id: CollectorIdentity, e: typeof env = env, lan: () => string[] = lanAddresses): string | null {
  const w = pairingHostWarning(id, e, lan);
  if (!w) return null;
  if (!driftWarned.has(id.certificateSha256)) { driftWarned.add(id.certificateSha256); log.warn(w); }
  return w;
}

// Boot-time expiry check: the cert is issued for 365 days but is a hard error the
// moment it lapses, so warn while there is still time to rotate. Returns the warning
// text when the cert expires within `thresholdMs` (default 30 days), else null.
// Pure so it can be unit-tested with an injected clock; main() logs the result.
export const CERT_EXPIRY_WARN_MS = 30 * 24 * 60 * 60 * 1000;
export function certExpiryWarning(id: CollectorIdentity, now: number = Date.now(), thresholdMs: number = CERT_EXPIRY_WARN_MS): string | null {
  const remaining = id.notAfter - now;
  if (remaining >= thresholdMs) return null;
  const on = new Date(id.notAfter).toISOString();
  const when = remaining <= 0 ? 'has expired' : `expires on ${on}`;
  return `collector certificate ${when}; run \`npm run identity:rotate -w collector\` to reissue (this invalidates every existing pairing — devices must re-pair).`;
}

// Project a persisted identity to the device pairing blob. `host` overrides the
// advertised host — main passes `pairingHost(id, env)` so /api/pairing (and the QR
// and CLI built from it) carry the LAN IPv4, not the unresolvable meta hostname.
export function toPairingImport(id: CollectorIdentity, host: string = id.publicPairing.host): PairingImport {
  return { ...id.publicPairing, host, deviceToken: id.deviceToken };
}

export type LoadOpts = {
  host?: string;
  ips?: string[];
  ingestPort?: number;
  atlantisPort?: number;
  keyBits?: number;
  now?: () => number; // clock source for the expiry check; defaults to Date.now (tests inject a future clock)
};

// Load the persisted identity, or create one on first run. An unreadable or
// expired identity is a hard error (actionable, points at rotate) — it is never
// silently regenerated, which would break every already-paired device.
export async function loadOrCreateIdentity(stateDir = defaultStateDir(), opts: LoadOpts = {}): Promise<CollectorIdentity> {
  await ensureOpenSSL();
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fsp.chmod(stateDir, 0o700).catch(() => {});
  const ports = { ingestPort: opts.ingestPort ?? DEFAULT_INGEST_PORT, atlantisPort: opts.atlantisPort ?? DEFAULT_ATLANTIS_PORT };
  const metaPath = path.join(stateDir, F_META);

  if (fs.existsSync(metaPath)) {
    let meta: { collectorId: string; host: string; generation: number };
    let certPem: string, keyPem: string, deviceToken: string;
    try {
      meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      certPem = await fsp.readFile(path.join(stateDir, F_CERT), 'utf8');
      keyPem = await fsp.readFile(path.join(stateDir, F_KEY), 'utf8');
      deviceToken = (await fsp.readFile(path.join(stateDir, F_TOKEN), 'utf8')).trim();
    } catch (e) {
      throw new Error(`collector identity at ${stateDir} is unreadable (${String(e)}). Fix permissions or run \`npm run identity:rotate\` to reissue.`);
    }
    const cert = new X509Certificate(certPem);
    const now = opts.now ?? Date.now;
    if (Date.parse(cert.validTo) < now()) {
      throw new Error(`collector certificate expired on ${cert.validTo}. Run \`npm run identity:rotate -- --host <hostname>\` to reissue and re-pair devices.`);
    }
    // A rotation interrupted between the key and cert renames can leave a mismatched
    // pair that fails every TLS handshake with an opaque error. Surface it here as the
    // same actionable hard error (IMPORTANT 5), rather than at connect time.
    try { tls.createSecureContext({ key: keyPem, cert: certPem }); }
    catch (e) {
      throw new Error(`collector certificate and private key at ${stateDir} do not match (${String(e)}). Run \`npm run identity:rotate -- --host <hostname>\` to reissue and re-pair devices.`);
    }
    return buildIdentity(meta, certPem, keyPem, deviceToken, ports);
  }

  return createIdentity(stateDir, { ...opts, generation: 1 }, ports);
}

// Write a fresh identity (new UUID, cert/key, device token) atomically. Shared by
// first-run creation and the rotate CLI, which bumps `generation`.
export async function createIdentity(
  stateDir: string,
  opts: LoadOpts & { generation: number },
  ports: { ingestPort: number; atlantisPort: number },
): Promise<CollectorIdentity> {
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const host = opts.host ?? os.hostname().replace(/\.local$/, '');
  const ips = opts.ips ?? lanAddresses();
  const collectorId = randomUUID();
  const deviceToken = randomBytes(32).toString('base64url');
  const { certPem, keyPem } = await generateCertificate(stateDir, { host, ips, keyBits: opts.keyBits });
  const meta = { collectorId, host, generation: opts.generation };
  // Key/token first: if we crash before the cert lands, the next boot sees a
  // partial identity and refuses rather than trusting half of it.
  await atomicWrite(stateDir, F_KEY, keyPem, 0o600);
  await atomicWrite(stateDir, F_TOKEN, deviceToken, 0o600);
  await atomicWrite(stateDir, F_CERT, certPem, 0o600);
  await atomicWrite(stateDir, F_META, JSON.stringify(meta, null, 2), 0o600);
  return buildIdentity(meta, certPem, keyPem, deviceToken, ports);
}
