// Pairing v2: the collector's public certificate + a per-device bearer token.
// The private key never appears here; only in memory and in the 0600 state file.
// `collectorId` is a persisted UUID, never an IP, so a DHCP lease change does not
// invalidate a pairing.
export type PublicPairing = {
  version: 2;
  collectorId: string;
  host: string;
  ingestPort: number;
  atlantisPort: number;
  certificateDerBase64: string;
  certificateSha256: string; // SHA-256 of the DER, 64 lowercase hex chars
};
export type PairingImport = PublicPairing & { deviceToken: string };
export type NativeIngestOptions = PublicPairing & {
  generation: number;
  deviceToken: string;
};
export type TransportError =
  | 'certificate_mismatch' | 'certificate_expired' | 'hostname_mismatch'
  | 'authentication_failed' | 'unpaired' | 'network' | 'module_unavailable';

// Server-side view of the persisted identity. Carries the private key, so it must
// never be serialized to a client; use `publicPairing` / `pairingImport` instead.
export type CollectorIdentity = {
  collectorId: string;
  host: string;
  generation: number;
  certificatePem: string;
  privateKeyPem: string;
  certificateDerBase64: string;
  certificateSha256: string;
  deviceToken: string;
  notBefore: number; // ms epoch
  notAfter: number;  // ms epoch
  ingestPort: number;
  atlantisPort: number;
  publicPairing: PublicPairing;
};

const isPort = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;

// Host validation shared with the certificate SAN check (identity.ts imports these).
// Pure string predicates with no Node dependency, so they live in this low-level
// module rather than in identity.ts — that keeps types.ts importable from the UI and
// avoids a types<->identity import cycle.
export const isHostname = (h: string): boolean =>
  /^[A-Za-z0-9]([A-Za-z0-9-]{0,62}\.?)+$/.test(h) && h.length <= 253;
export const isIp = (s: string): boolean => {
  try { void new URL(`http://[${s}]`); return s.includes(':'); } catch { /* not ipv6 */ }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((o) => Number(o) <= 255);
};

// A base64url token encoding exactly 32 random bytes.
export function isDeviceToken(s: unknown): s is string {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return false;
  try { return Buffer.from(s, 'base64url').length === 32; } catch { return false; }
}

// Cumulative structural validation of an untrusted pairing blob. TLS trust
// (anchor, hostname, validity) is verified separately by the platform at connect
// time; this only guards the fields the collector round-trips.
export function isPublicPairing(x: unknown): x is PublicPairing {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  if (p.version !== 2) return false;
  if (typeof p.collectorId !== 'string' || !UUID.test(p.collectorId)) return false;
  if (typeof p.host !== 'string' || p.host.length === 0) return false;
  if (!isPort(p.ingestPort) || !isPort(p.atlantisPort)) return false;
  if (typeof p.certificateSha256 !== 'string' || !HEX64.test(p.certificateSha256)) return false;
  if (typeof p.certificateDerBase64 !== 'string') return false;
  let der: Buffer;
  try { der = Buffer.from(p.certificateDerBase64, 'base64'); } catch { return false; }
  if (der.length === 0 || der[0] !== 0x30) return false; // DER SEQUENCE tag
  return true;
}

export function isPairingImport(x: unknown): x is PairingImport {
  return isPublicPairing(x) && isDeviceToken((x as Record<string, unknown>).deviceToken);
}

// The QR-carried pairing: the full identity minus the ~1.4 KB DER (too large for a
// screen QR), plus `certPort` — the port of the dedicated LAN cert listener — so the
// app can fetch the DER from `GET /api/cert` and verify its SHA-256 against
// `certificateSha256`. The QR is the root of trust; the DER travels over plain HTTP
// because it is public in every TLS handshake anyway.
export type QrPairing = Omit<PairingImport, 'certificateDerBase64'> & { certPort: number };

// Structural validation of a QR blob: the PublicPairing checks minus the DER,
// plus `certPort`. `deviceToken` is validated too — it is a field of QrPairing and
// the security-critical secret the app persists, so `isQrPairing` guards it rather
// than leaving a sound-looking type with an unchecked member. Mirrors the app's
// `parseQrPairing`; the shared fixture in the pairing spec pins both sides.
export function isQrPairing(x: unknown): x is QrPairing {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  if (p.version !== 2) return false;
  // Reject the pre-rename key outright (parity with the app's parseQrPairing): a
  // blob carrying `httpPort` is a stale/foreign encoding, not a valid QrPairing.
  if ('httpPort' in p) return false;
  if (typeof p.collectorId !== 'string' || !UUID.test(p.collectorId)) return false;
  if (typeof p.host !== 'string' || !(isHostname(p.host) || isIp(p.host))) return false;
  if (!isPort(p.certPort) || !isPort(p.ingestPort) || !isPort(p.atlantisPort)) return false;
  if (typeof p.certificateSha256 !== 'string' || !HEX64.test(p.certificateSha256)) return false;
  if (!isDeviceToken(p.deviceToken)) return false;
  return true;
}

// Project a persisted identity to the QR blob. Key insertion order is fixed to the
// pairing spec's fixture (version, collectorId, host, certPort, ingestPort,
// atlantisPort, certificateSha256, deviceToken) so `JSON.stringify` is byte-stable
// and matches the app-side literal.
export function toQrPairing(id: CollectorIdentity, certPort: number): QrPairing {
  const p = id.publicPairing;
  return {
    version: 2,
    collectorId: p.collectorId,
    host: p.host,
    certPort,
    ingestPort: p.ingestPort,
    atlantisPort: p.atlantisPort,
    certificateSha256: p.certificateSha256,
    deviceToken: id.deviceToken,
  };
}
