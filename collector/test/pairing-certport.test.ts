import { describe, it, expect } from 'vitest';
import { createCollectorHarness } from './fixtures/harness.js';
import type { PairingImport } from '../src/security/types.js';

const DEVICE_TOKEN = Buffer.alloc(32, 7).toString('base64url');
const DER_B64 = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]).toString('base64');

function pairing(): PairingImport {
  return {
    version: 2,
    collectorId: '6f1c2b0e-3b7a-4c1d-9e2f-0a1b2c3d4e5f',
    host: '192.168.0.10',
    ingestPort: 8788,
    atlantisPort: 10909,
    certificateDerBase64: DER_B64,
    certificateSha256: '0'.repeat(64),
    deviceToken: DEVICE_TOKEN,
  };
}

describe('/api/pairing certPort (F3)', () => {
  it('adds certPort to the authenticated pairing blob when configured', async () => {
    const h = await createCollectorHarness({ getPairing: pairing, certPort: 8789 });
    try {
      const cookie = await h.login();
      const res = await fetch(h.url + '/api/pairing', { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.certPort).toBe(8789);
      // Additive: the original fields survive unchanged.
      expect(body.deviceToken).toBe(DEVICE_TOKEN);
      expect(body.certificateDerBase64).toBe(DER_B64);
    } finally {
      await h.close();
    }
  });

  it('omits certPort when not configured (back-compat)', async () => {
    const h = await createCollectorHarness({ getPairing: pairing });
    try {
      const cookie = await h.login();
      const body = await (await fetch(h.url + '/api/pairing', { headers: { cookie } })).json();
      expect('certPort' in body).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('keeps /api/pairing behind auth (unchanged)', async () => {
    const h = await createCollectorHarness({ getPairing: pairing, certPort: 8789 });
    try {
      expect((await fetch(h.url + '/api/pairing')).status).toBe(401);
    } finally {
      await h.close();
    }
  });
});
