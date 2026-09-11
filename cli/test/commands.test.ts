import { describe, it, expect } from 'vitest';
import { createCollectorHarness } from '../../collector/test/fixtures/harness.js';
import type { PairingImport } from '../../collector/src/security/types.js';
import { QR_PAIRING_FIXTURE_FIELDS as F } from '../../collector/test/fixtures/qrPairing.js';
import { runCli, makeEntry } from './helpers.js';

// A PairingImport (with a tiny real DER SEQUENCE) matching the shared fixture, for a
// harness whose GET /api/pairing returns a stable, decodable blob.
function fixturePairing(): PairingImport {
  const der = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]).toString('base64');
  return {
    version: 2, collectorId: F.collectorId, host: F.host,
    ingestPort: F.ingestPort, atlantisPort: F.atlantisPort,
    certificateDerBase64: der, certificateSha256: F.certificateSha256, deviceToken: F.deviceToken,
  };
}

describe('status', () => {
  it('prints a snapshot summary and --json', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.addEntry(makeEntry());
      const text = await runCli(['status'], { harness: h });
      expect(text.code).toBe(0);
      expect(text.stdout).toContain('Terminus collector');
      expect(text.stdout).toContain('paused');

      const json = await runCli(['status', '--json'], { harness: h });
      const snap = JSON.parse(json.stdout);
      expect(snap.type).toBe('snapshot');
      expect(snap.protocolVersion).toBeGreaterThanOrEqual(3);
    } finally { await h.close(); }
  });
});

describe('ls', () => {
  it('lists entries with the shared columns', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.addEntry(makeEntry());
      const r = await runCli(['ls'], { harness: h });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('POST');
      expect(r.stdout).toContain('api.example.com/v1/items');
    } finally { await h.close(); }
  });

  it('applies the --status filter client-side', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.addEntry(makeEntry({ id: 'ok', status: 200 }));
      h.store.addEntry(makeEntry({ id: 'bad', status: 500, url: 'https://api.example.com/boom' }));
      const r = await runCli(['ls', '--status', '5xx'], { harness: h });
      expect(r.stdout).toContain('/boom');
      expect(r.stdout).not.toContain('/v1/items');
    } finally { await h.close(); }
  });

  it('--json emits an array of summaries', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.addEntry(makeEntry());
      const r = await runCli(['ls', '--json'], { harness: h });
      const rows = JSON.parse(r.stdout);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows[0].method).toBe('POST');
    } finally { await h.close(); }
  });
});

describe('show', () => {
  it('prints headers, timing and pretty JSON bodies', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.addEntry(makeEntry());
      const r = await runCli(['show', 'd1/r1'], { harness: h });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Request headers');
      expect(r.stdout).toContain('content-type: application/json');
      expect(r.stdout).toContain('"ok": true'); // pretty-printed JSON response body
    } finally { await h.close(); }
  });

  it('--curl reproduces the request', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.addEntry(makeEntry());
      const r = await runCli(['show', 'd1/r1', '--curl'], { harness: h });
      expect(r.stdout).toContain('curl -X POST');
      expect(r.stdout).toContain('api.example.com/v1/items');
      expect(r.stdout).toContain('--data-raw');
    } finally { await h.close(); }
  });
});

describe('export', () => {
  it('streams a HAR to stdout by default', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.addEntry(makeEntry());
      const r = await runCli(['export'], { harness: h });
      const har = JSON.parse(r.stdout);
      expect(har.log.version).toBe('1.2');
      expect(har.log.entries.length).toBeGreaterThanOrEqual(1);
    } finally { await h.close(); }
  });

  it('streams JSON with --json and writes to a file with -o', async () => {
    const h = await createCollectorHarness();
    const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminus-export-'));
    try {
      h.store.addEntry(makeEntry());
      const out = path.join(dir, 'cap.json');
      const r = await runCli(['export', '--json', '-o', out], { harness: h });
      expect(r.code).toBe(0);
      const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
      expect(Array.isArray(doc.entries)).toBe(true);
    } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('pause / resume / clear', () => {
  it('pauses and resumes the live stream', async () => {
    const h = await createCollectorHarness();
    try {
      const p = await runCli(['pause'], { harness: h });
      expect(p.stdout).toContain('paused');
      const s = await runCli(['status', '--json'], { harness: h });
      expect(JSON.parse(s.stdout).paused).toBe(true);
      const r = await runCli(['resume'], { harness: h });
      expect(r.stdout).toContain('resumed');
    } finally { await h.close(); }
  });

  it('clears captured data', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.addEntry(makeEntry());
      const c = await runCli(['clear'], { harness: h });
      expect(c.code).toBe(0);
      expect(h.store.entries('d1')).toHaveLength(0);
    } finally { await h.close(); }
  });
});

describe('devices', () => {
  it('lists paired devices', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.touchDevice({ deviceId: 'd1', platform: 'ios', appVersion: '1.2.3', buildProfile: 'debug', dropped: 0, lastSeen: Date.now() }, 'ingest');
      const r = await runCli(['devices'], { harness: h });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('d1');
      expect(r.stdout).toContain('ios');
    } finally { await h.close(); }
  });

  it('prints a CHANNELS column listing the observed channels', async () => {
    const h = await createCollectorHarness();
    try {
      // A phone heard on both channels shows both, in the fixed ingest,atlantis order.
      h.store.touchDevice({ deviceId: 'd1', platform: 'android', appVersion: '1', buildProfile: 'unknown', dropped: 0, lastSeen: Date.now() }, 'ingest');
      h.store.touchDevice({ deviceId: 'd1', platform: 'android', appVersion: '1', buildProfile: 'atlantis', dropped: 0, lastSeen: Date.now() }, 'atlantis');
      const r = await runCli(['devices'], { harness: h });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('CHANNELS');
      expect(r.stdout).toContain('ingest,atlantis');
    } finally { await h.close(); }
  });
});

describe('pair --json', () => {
  it('prints the QrPairing blob with certPort and deviceToken', async () => {
    const h = await createCollectorHarness({ getPairing: () => fixturePairing(), certPort: F.certPort });
    try {
      const r = await runCli(['pair', '--json'], { harness: h });
      const blob = JSON.parse(r.stdout);
      expect(blob.version).toBe(2);
      expect(blob.certPort).toBe(F.certPort);
      expect(blob.deviceToken).toBe(F.deviceToken);
      expect('certificateDerBase64' in blob).toBe(false);
    } finally { await h.close(); }
  });
});

describe('pair advertised host + drift warning', () => {
  it('shows the advertised host and prints no drift warning when the SAN is healthy', async () => {
    const h = await createCollectorHarness({ getPairing: () => fixturePairing(), certPort: F.certPort });
    try {
      const r = await runCli(['pair'], { harness: h });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`${F.host}:${F.ingestPort}`);
      expect(r.stderr).not.toContain('certificate SAN');
    } finally { await h.close(); }
  });

  it('prints the pairing-host drift warning to stderr, keeping stdout clean in --json', async () => {
    const warning = 'no current LAN IPv4 is in the certificate SAN (cert has 127.0.0.1); devices may fail to connect; run `npm run identity:rotate` to regenerate';
    const h = await createCollectorHarness({ getPairing: () => fixturePairing(), certPort: F.certPort, getPairingWarning: () => warning });
    try {
      const r = await runCli(['pair', '--json'], { harness: h });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('certificate SAN');
      expect(r.stderr).toContain('identity:rotate');
      // stdout stays a parseable QrPairing blob.
      expect(() => JSON.parse(r.stdout)).not.toThrow();
    } finally { await h.close(); }
  });
});
