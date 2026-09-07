import { describe, it, expect } from 'vitest';
import { isQrPairing, toQrPairing } from '../src/security/types.js';
import type { CollectorIdentity } from '../src/security/types.js';
import { QR_PAIRING_FIXTURE, QR_PAIRING_FIXTURE_FIELDS as F } from './fixtures/qrPairing.js';

// A CollectorIdentity whose public pairing matches the shared fixture. The DER is
// a real (short) DER SEQUENCE so publicPairing stays structurally valid; toQrPairing
// drops it, so its exact bytes are irrelevant to the QR string.
function fixtureIdentity(): CollectorIdentity {
  const der = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]).toString('base64');
  const publicPairing = {
    version: 2 as const,
    collectorId: F.collectorId,
    host: F.host,
    ingestPort: F.ingestPort,
    atlantisPort: F.atlantisPort,
    certificateDerBase64: der,
    certificateSha256: F.certificateSha256,
  };
  return {
    collectorId: F.collectorId,
    host: F.host,
    generation: 1,
    certificatePem: '',
    privateKeyPem: '',
    certificateDerBase64: der,
    certificateSha256: F.certificateSha256,
    deviceToken: F.deviceToken,
    notBefore: 0,
    notAfter: 0,
    ingestPort: F.ingestPort,
    atlantisPort: F.atlantisPort,
    publicPairing,
  };
}

describe('isQrPairing (F1)', () => {
  it('accepts the shared fixture', () => {
    expect(isQrPairing(JSON.parse(QR_PAIRING_FIXTURE))).toBe(true);
  });

  it('rejects a blob missing certPort', () => {
    const p = JSON.parse(QR_PAIRING_FIXTURE) as Record<string, unknown>;
    delete p.certPort;
    expect(isQrPairing(p)).toBe(false);
  });

  it('rejects an out-of-range certPort', () => {
    expect(isQrPairing({ ...JSON.parse(QR_PAIRING_FIXTURE), certPort: 0 })).toBe(false);
    expect(isQrPairing({ ...JSON.parse(QR_PAIRING_FIXTURE), certPort: 70000 })).toBe(false);
  });

  it('rejects wrong version, bad UUID, empty host and non-hex sha256', () => {
    const base = JSON.parse(QR_PAIRING_FIXTURE);
    expect(isQrPairing({ ...base, version: 1 })).toBe(false);
    expect(isQrPairing({ ...base, collectorId: 'not-a-uuid' })).toBe(false);
    expect(isQrPairing({ ...base, host: '' })).toBe(false);
    expect(isQrPairing({ ...base, certificateSha256: 'z'.repeat(64) })).toBe(false);
  });

  it('accepts a hostname host as well as an IPv4 host', () => {
    const base = JSON.parse(QR_PAIRING_FIXTURE);
    expect(isQrPairing({ ...base, host: 'terminus.local' })).toBe(true);
    expect(isQrPairing({ ...base, host: 'my-collector' })).toBe(true);
    expect(isQrPairing({ ...base, host: '10.0.0.42' })).toBe(true);
  });

  it('rejects a malformed host (parity with the cert SAN check)', () => {
    const base = JSON.parse(QR_PAIRING_FIXTURE);
    expect(isQrPairing({ ...base, host: 'bad host' })).toBe(false);
    expect(isQrPairing({ ...base, host: '-nope' })).toBe(false);
    expect(isQrPairing({ ...base, host: 'a/b' })).toBe(false);
    expect(isQrPairing({ ...base, host: 'under_score' })).toBe(false);
    expect(isQrPairing({ ...base, host: '' })).toBe(false);
  });

  it('rejects a blob carrying the legacy httpPort key (parity with the app)', () => {
    const withLegacy = { ...JSON.parse(QR_PAIRING_FIXTURE), httpPort: 8787 };
    expect(isQrPairing(withLegacy)).toBe(false);
    // Even if certPort is also present, the stale key means a stale encoding.
    expect(isQrPairing({ ...JSON.parse(QR_PAIRING_FIXTURE), httpPort: 8789 })).toBe(false);
  });

  it('rejects a deviceToken that does not decode to 32 bytes', () => {
    expect(isQrPairing({ ...JSON.parse(QR_PAIRING_FIXTURE), deviceToken: 'too-short' })).toBe(false);
  });

  it('does not require the DER (that is the whole point of the QR form)', () => {
    const p = JSON.parse(QR_PAIRING_FIXTURE);
    expect('certificateDerBase64' in p).toBe(false);
    expect(isQrPairing(p)).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isQrPairing(null)).toBe(false);
    expect(isQrPairing('x')).toBe(false);
  });
});

describe('toQrPairing (F1)', () => {
  it('serializes byte-for-byte to the shared fixture literal', () => {
    const qr = toQrPairing(fixtureIdentity(), F.certPort);
    expect(JSON.stringify(qr)).toBe(QR_PAIRING_FIXTURE);
  });

  it('produces a blob that passes isQrPairing', () => {
    const qr = toQrPairing(fixtureIdentity(), 8787);
    expect(isQrPairing(qr)).toBe(true);
  });

  it('omits the DER and carries the deviceToken + certPort', () => {
    const qr = toQrPairing(fixtureIdentity(), 9000) as Record<string, unknown>;
    expect('certificateDerBase64' in qr).toBe(false);
    expect(qr.certPort).toBe(9000);
    expect(qr.deviceToken).toBe(F.deviceToken);
  });
});
