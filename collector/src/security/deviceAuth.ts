import { timingSafeEqual } from 'node:crypto';
import type { SecureContextOptions } from 'node:tls';
import type { CollectorIdentity } from './types.js';

// Constant-time device-token compare; timingSafeEqual throws on a length mismatch,
// so guard the length first.
export function verifyDeviceToken(candidate: string | null | undefined, deviceToken: string): boolean {
  if (candidate == null) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(deviceToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Extract a Bearer token from an upgrade/ingest request's Authorization header.
export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer (.+)$/.exec(header);
  return m ? m[1] : null;
}

// Shared TLS server options. TLS 1.2 floor with ECDHE ciphers; HTTPS keeps TLS 1.3
// enabled by not pinning maxVersion. The 10s handshake deadline bounds a client
// that opens a socket but never completes the handshake.
export function tlsServerOptions(identity: CollectorIdentity): SecureContextOptions & { handshakeTimeout: number; minVersion: 'TLSv1.2' } {
  return {
    key: identity.privateKeyPem,
    cert: identity.certificatePem,
    minVersion: 'TLSv1.2',
    ciphers: 'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384',
    handshakeTimeout: 10_000,
  };
}
