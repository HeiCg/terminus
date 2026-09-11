import { describe, it, expect, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  generateCertificate, loadOrCreateIdentity, toPairingImport,
  sanArg, certSanIps, pairingHost, pairingHostWarning,
} from '../src/security/identity.js';
import { log } from '../src/log.js';
import { createCollectorHarness } from './fixtures/harness.js';
import type { CollectorIdentity, PairingImport } from '../src/security/types.js';

const dirs: string[] = [];
async function tmp(): Promise<string> { const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-ph-')); dirs.push(d); return d; }
afterEach(async () => {
  while (dirs.length) await fsp.rm(dirs.pop()!, { recursive: true, force: true });
  delete process.env.TERMINUS_PAIRING_HOST;
  delete process.env.NETCAPTURE_PAIRING_HOST;
  vi.restoreAllMocks();
});

// A no-op env reader so the tests never depend on the ambient TERMINUS_ vars.
const noEnv = () => undefined;

describe('sanArg classification (item 2)', () => {
  it('emits a name host as DNS: and keeps localhost + IPs', () => {
    const s = sanArg('mac', ['192.168.1.10', '127.0.0.1']);
    expect(s).toContain('DNS:mac');
    expect(s).toContain('DNS:localhost');
    expect(s).toContain('IP:192.168.1.10');
    expect(s).toContain('IP:127.0.0.1');
    expect(s).not.toContain('DNS:192.168.1.10');
  });

  it('emits an IP host as IP:, never DNS: (the --host <ip> bug)', () => {
    const s = sanArg('10.0.0.5', ['127.0.0.1']);
    expect(s).toContain('IP:10.0.0.5');
    expect(s).toContain('DNS:localhost');
    expect(s).not.toContain('DNS:10.0.0.5');
  });

  it('does not duplicate an IP host already present in ips', () => {
    const s = sanArg('10.0.0.5', ['10.0.0.5', '127.0.0.1']);
    expect(s.match(/IP:10\.0\.0\.5/g)).toHaveLength(1);
  });
});

describe('certSanIps + generation (item 2)', () => {
  it('an IP --host lands in the cert SAN as an IP entry, not a DNS name', async () => {
    const d = await tmp();
    const { certPem } = await generateCertificate(d, { host: '10.0.0.5', ips: ['127.0.0.1'], days: 1, keyBits: 2048 });
    expect(certSanIps(certPem)).toContain('10.0.0.5');
  });

  it('reads every IP Address SAN entry', async () => {
    const d = await tmp();
    const { certPem } = await generateCertificate(d, { host: 'mac', ips: ['192.168.1.10', '127.0.0.1'], days: 1, keyBits: 2048 });
    const ips = certSanIps(certPem);
    expect(ips).toContain('192.168.1.10');
    expect(ips).toContain('127.0.0.1');
  });
});

// Build a real identity whose cert SAN covers `ips`, so pairingHost can match.
async function identityWith(ips: string[]): Promise<CollectorIdentity> {
  const d = await tmp();
  return loadOrCreateIdentity(d, { host: 'localhost', ips, keyBits: 2048 });
}

describe('pairingHost selection (item 1)', () => {
  it('prefers a valid TERMINUS_PAIRING_HOST override (hostname or IP)', async () => {
    const id = await identityWith(['192.168.9.9', '127.0.0.1']);
    expect(pairingHost(id, () => 'pinned.example', () => ['192.168.9.9'])).toBe('pinned.example');
    expect(pairingHost(id, () => '203.0.113.7', () => ['192.168.9.9'])).toBe('203.0.113.7');
  });

  it('ignores an invalid override and falls through to LAN detection', async () => {
    const id = await identityWith(['192.168.9.9', '127.0.0.1']);
    expect(pairingHost(id, () => 'bad host;rm -rf /', () => ['192.168.9.9', '::1'])).toBe('192.168.9.9');
  });

  it('picks the first LAN IPv4 that is present in the cert SAN', async () => {
    const id = await identityWith(['192.168.9.9', '127.0.0.1']);
    // 10.0.0.1 is a current LAN IP but not in the SAN; 192.168.9.9 is in the SAN.
    expect(pairingHost(id, noEnv, () => ['10.0.0.1', '192.168.9.9', '::1', '127.0.0.1'])).toBe('192.168.9.9');
  });

  it('falls back to identity meta.host and warns exactly once when no LAN IPv4 is in the SAN', async () => {
    const id = await identityWith(['127.0.0.1']); // SAN carries no routable LAN IPv4
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const lan = () => ['10.9.9.9', '::1']; // present on the host but absent from the SAN
    expect(pairingHost(id, noEnv, lan)).toBe('localhost');
    expect(pairingHost(id, noEnv, lan)).toBe('localhost');
    const driftWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('certificate SAN'));
    expect(driftWarnings).toHaveLength(1);
    expect(String(driftWarnings[0][0])).toMatch(/identity:rotate/);
  });
});

describe('pairingHostWarning (items 3 + 5)', () => {
  it('is null when a LAN IPv4 is covered by the SAN', async () => {
    const id = await identityWith(['192.168.9.9', '127.0.0.1']);
    expect(pairingHostWarning(id, noEnv, () => ['192.168.9.9'])).toBeNull();
  });

  it('is null when a valid override pins the host', async () => {
    const id = await identityWith(['127.0.0.1']);
    expect(pairingHostWarning(id, () => '203.0.113.7', () => ['10.9.9.9'])).toBeNull();
  });

  it('names the cert SAN IPs when drift is detected, without logging', async () => {
    const id = await identityWith(['127.0.0.1']);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const w = pairingHostWarning(id, noEnv, () => ['10.9.9.9']);
    expect(w).toMatch(/no current LAN IPv4/);
    expect(w).toContain('127.0.0.1');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('GET /api/pairing carries the advertised host + warning', () => {
  const DEVICE_TOKEN = Buffer.alloc(32, 9).toString('base64url');
  const DER_B64 = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]).toString('base64');
  const ipPairing = (): PairingImport => ({
    version: 2,
    collectorId: '6f1c2b0e-3b7a-4c1d-9e2f-0a1b2c3d4e5f',
    host: '192.168.9.9', // pairingHost already resolved to the LAN IPv4
    ingestPort: 8788,
    atlantisPort: 10909,
    certificateDerBase64: DER_B64,
    certificateSha256: '0'.repeat(64),
    deviceToken: DEVICE_TOKEN,
  });

  it('returns the IP host and a null warning when the SAN is healthy', async () => {
    const h = await createCollectorHarness({ getPairing: ipPairing, certPort: 8789 });
    try {
      const cookie = await h.login();
      const body = await (await fetch(h.url + '/api/pairing', { headers: { cookie } })).json();
      expect(body.host).toBe('192.168.9.9');
      expect(body.pairingHostWarning).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('surfaces the drift warning through pairingHostWarning', async () => {
    const warning = 'no current LAN IPv4 is in the certificate SAN (cert has 127.0.0.1); devices may fail to connect; run `npm run identity:rotate` to regenerate';
    const h = await createCollectorHarness({ getPairing: ipPairing, getPairingWarning: () => warning });
    try {
      const cookie = await h.login();
      const body = await (await fetch(h.url + '/api/pairing', { headers: { cookie } })).json();
      expect(body.pairingHostWarning).toBe(warning);
    } finally {
      await h.close();
    }
  });
});

describe('toPairingImport host override', () => {
  it('overrides the advertised host, leaving other fields intact', async () => {
    const id = await identityWith(['192.168.9.9', '127.0.0.1']);
    const p = toPairingImport(id, '192.168.9.9');
    expect(p.host).toBe('192.168.9.9');
    expect(p.deviceToken).toBe(id.deviceToken);
    expect(p.certificateSha256).toBe(id.certificateSha256);
    // Default keeps the identity meta host.
    expect(toPairingImport(id).host).toBe('localhost');
  });
});
