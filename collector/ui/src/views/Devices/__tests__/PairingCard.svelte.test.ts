import { render, screen } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The pairing fetch is mocked so the card's mount attachment resolves against a
// controlled value instead of the network.
vi.mock('../../../lib/api.js', () => ({
  fetchPairing: vi.fn(),
}));

import PairingCard from '../PairingCard.svelte';
import { fetchPairing } from '../../../lib/api.js';
import type { PairingInfo } from '../../../lib/api.js';
import { buildQrPayload } from '../../../lib/pairing.js';
import { encodeQr } from '../../../lib/qr.js';
// Cross-repo contract: the QR payload the collector emits must satisfy the very
// validator the server ships, and reproduce the shared fixture literal that the
// app's parseQrPairing is pinned against.
import { isQrPairing } from '../../../../../src/security/types.js';
import { QR_PAIRING_FIXTURE, QR_PAIRING_FIXTURE_FIELDS as F } from '../../../../../test/fixtures/qrPairing.js';

const info: PairingInfo = {
  version: 2,
  collectorId: '6f1c2b0e-3b7a-4c1d-9e2f-0a1b2c3d4e5f',
  host: '192.168.1.42',
  certPort: 8789,
  ingestPort: 8443,
  atlantisPort: 8444,
  certificateDerBase64: 'ZGVy',
  certificateSha256: 'a1b2c3'.padEnd(64, '0'),
  deviceToken: Buffer.alloc(32, 3).toString('base64url'),
};

beforeEach(() => {
  vi.mocked(fetchPairing).mockReset();
});

describe('PairingCard', () => {
  it('shows the address, grouped code and a QR svg once pairing resolves', async () => {
    vi.mocked(fetchPairing).mockResolvedValue(info);
    const { container } = render(PairingCard);

    // The address and code appear only after the async fetch resolves.
    expect(await screen.findByText('192.168.1.42:8443')).toBeInTheDocument();
    // First 6 hex, upper-cased, grouped 3+3.
    expect(screen.getByTestId('pairing-code').textContent).toBe('A1B 2C3');
    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'Pairing QR code' })).toBeInTheDocument();
    // The pt-BR pairing steps are present.
    expect(screen.getByText('Network Capture')).toBeInTheDocument();
  });

  it('shows the unavailable note and a Retry when pairing is null', async () => {
    vi.mocked(fetchPairing).mockResolvedValue(null);
    render(PairingCard);

    expect(await screen.findByText('Pairing unavailable (identity not ready)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Pairing QR code' })).toBeNull();
  });

  it('retries the fetch on demand, recovering when identity becomes ready', async () => {
    vi.mocked(fetchPairing).mockResolvedValueOnce(null).mockResolvedValueOnce(info);
    render(PairingCard);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    retry.click();
    expect(await screen.findByText('192.168.1.42:8443')).toBeInTheDocument();
    expect(vi.mocked(fetchPairing)).toHaveBeenCalledTimes(2);
  });
});

describe('buildQrPayload (F4)', () => {
  it('produces a QrPairing blob the server validator accepts', () => {
    const decoded = JSON.parse(buildQrPayload(info));
    expect(isQrPairing(decoded)).toBe(true);
  });

  it('reproduces the shared fixture literal byte-for-byte', () => {
    const fixtureInfo: PairingInfo = {
      version: 2,
      collectorId: F.collectorId,
      host: F.host,
      certPort: F.certPort,
      ingestPort: F.ingestPort,
      atlantisPort: F.atlantisPort,
      certificateDerBase64: 'ZGVy',
      certificateSha256: F.certificateSha256,
      deviceToken: F.deviceToken,
    };
    expect(buildQrPayload(fixtureInfo)).toBe(QR_PAIRING_FIXTURE);
  });

  it('falls back to the loopback default certPort for an older collector', () => {
    const { certPort: _omit, ...noPort } = info;
    const decoded = JSON.parse(buildQrPayload(noPort));
    expect(decoded.certPort).toBe(8789);
    expect(isQrPairing(decoded)).toBe(true);
  });
});

describe('QR capacity (F4)', () => {
  it('does not throw encoding an IPv4 host', () => {
    expect(() => encodeQr(buildQrPayload(info))).not.toThrow();
  });

  it('does not throw encoding a 63-char hostname', () => {
    const longHost = 'a'.repeat(63);
    const payload = buildQrPayload({ ...info, host: longHost });
    expect(payload).toContain(longHost);
    expect(() => encodeQr(payload)).not.toThrow();
  });
});
