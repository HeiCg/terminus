import { describe, it, expect } from 'vitest';
import { createCollectorHarness } from '../../collector/test/fixtures/harness.js';
import type { PairingImport } from '../../collector/src/security/types.js';
import { isQrPairing } from '../../collector/src/security/types.js';
import { encodeQr } from '../../collector/src/security/qr.js';
import { QR_PAIRING_FIXTURE, QR_PAIRING_FIXTURE_FIELDS as F } from '../../collector/test/fixtures/qrPairing.js';
import { buildQrPairing, qrMatrix, qrPayload, type PairingResponse } from '../src/commands/pair.js';
import { toHalfBlocks, fromHalfBlocks, qrLines, QUIET_ZONE } from '../src/qrterm.js';
import { runCli } from './helpers.js';

function fixturePairing(): PairingImport {
  const der = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]).toString('base64');
  return {
    version: 2, collectorId: F.collectorId, host: F.host,
    ingestPort: F.ingestPort, atlantisPort: F.atlantisPort,
    certificateDerBase64: der, certificateSha256: F.certificateSha256, deviceToken: F.deviceToken,
  };
}

const response: PairingResponse = { ...fixturePairing(), certPort: F.certPort };

// Half-block character set; a QR output line is composed only of these.
const QR_CHARS = new Set([' ', '█', '▀', '▄']);

// Reconstruct a module matrix from the CLI's half-block output: keep the QR lines,
// decode them, then trim to the bounding box of dark modules (drops the quiet zone).
function extractMatrix(stdout: string): boolean[][] {
  const lines = stdout.split('\n').filter((l) => l.length > 0 && Array.from(l).every((ch) => QR_CHARS.has(ch)));
  const rows = fromHalfBlocks(lines);
  let top = Infinity, bottom = -1, left = Infinity, right = -1;
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      if (rows[y][x]) { top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x); }
    }
  }
  const out: boolean[][] = [];
  for (let y = top; y <= bottom; y++) out.push(rows[y].slice(left, right + 1));
  return out;
}

describe('pair --qr', () => {
  it('builds the QrPairing in the shared-fixture byte order (reusing toQrPairing)', () => {
    expect(qrPayload(response)).toBe(QR_PAIRING_FIXTURE);
    expect(isQrPairing(buildQrPairing(response))).toBe(true);
  });

  it('encodes the expected payload with the shared encoder', () => {
    expect(qrMatrix(response)).toEqual(encodeQr(QR_PAIRING_FIXTURE));
  });

  it('half-block rendering round-trips to the same matrix', () => {
    const m = encodeQr(QR_PAIRING_FIXTURE);
    const decoded = fromHalfBlocks(toHalfBlocks(m)).slice(0, m.length);
    expect(decoded).toEqual(m);
  });

  it('qrLines renders a 4-module quiet zone; plain vs coloured', () => {
    const m = encodeQr(QR_PAIRING_FIXTURE);
    expect(QUIET_ZONE).toBe(4);

    const plain = qrLines(m, { color: false });
    // 4 light modules on top = 2 all-space half-block lines; 4-module left margin.
    expect(plain[0]).toMatch(/^ +$/);
    expect(plain[1]).toMatch(/^ +$/);
    expect(plain.every((l) => /^ {4}/.test(l))).toBe(true);
    // Plain lines are only half-block characters (no ANSI).
    expect(plain.every((l) => /^[ █▀▄]+$/u.test(l))).toBe(true);

    const coloured = qrLines(m, { color: true });
    // Each coloured line sets white-bg/black-fg and resets, so the code reads the
    // same on a dark terminal.
    expect(coloured.every((l) => l.startsWith('\x1b[30;47m') && l.endsWith('\x1b[0m'))).toBe(true);
    // Stripping the ANSI wrappers recovers the plain lines.
    expect(coloured.map((l) => l.replace(/^\x1b\[30;47m/, '').replace(/\x1b\[0m$/, ''))).toEqual(plain);
  });

  it('the CLI output decodes back to encodeQr(expected payload); token warning on stderr, payload only on stdout', async () => {
    const h = await createCollectorHarness({ getPairing: () => fixturePairing(), certPort: F.certPort });
    try {
      const r = await runCli(['pair', '--qr'], { harness: h });
      expect(r.code).toBe(0);
      // The warning is on stderr; stdout carries only the QR (no prose).
      expect(r.stderr).toContain('WARNING');
      expect(r.stderr.toLowerCase()).toContain('device token');
      expect(r.stdout).not.toContain('WARNING');
      expect(extractMatrix(r.stdout)).toEqual(encodeQr(QR_PAIRING_FIXTURE));
    } finally { await h.close(); }
  });

  it('--json prints only the blob on stdout; the token warning goes to stderr', async () => {
    const h = await createCollectorHarness({ getPairing: () => fixturePairing(), certPort: F.certPort });
    try {
      const r = await runCli(['pair', '--json'], { harness: h });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(JSON.parse(QR_PAIRING_FIXTURE));
      expect(r.stdout).not.toContain('WARNING');
      expect(r.stderr).toContain('WARNING');
    } finally { await h.close(); }
  });
});
