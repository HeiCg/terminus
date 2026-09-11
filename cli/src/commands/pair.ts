import { getJson } from '../http.js';
import { toQrPairing } from '../../../collector/src/security/types.js';
import type { CollectorIdentity, QrPairing } from '../../../collector/src/security/types.js';
import { encodeQr } from '../../../collector/src/security/qr.js';
import { qrLines } from '../qrterm.js';
import { line, jsonLine, errline, type Ctx } from '../context.js';
import { flagBool } from '../args.js';

// The /api/pairing response: a PairingImport plus the additive certPort.
export type PairingResponse = {
  version: 2; collectorId: string; host: string; ingestPort: number; atlantisPort: number;
  certificateDerBase64: string; certificateSha256: string; deviceToken: string; certPort?: number;
  // Set by the collector when no current LAN IPv4 is in the cert SAN, so a device
  // dialling the advertised host would fail the SAN check. Null/absent otherwise.
  pairingHostWarning?: string | null;
};

// Default LAN cert-listener port, mirroring the UI's fallback when an older collector
// omits certPort.
const DEFAULT_CERT_PORT = 8789;

// Build the QrPairing the app scans, reusing the collector's own `toQrPairing` so the
// key order (the byte-stable pairing contract) is identical to the dashboard's QR.
// The response carries every field toQrPairing reads, shaped here as the identity
// slice it expects.
export function buildQrPairing(p: PairingResponse): QrPairing {
  const certPort = p.certPort ?? DEFAULT_CERT_PORT;
  const idish = {
    publicPairing: {
      collectorId: p.collectorId, host: p.host,
      ingestPort: p.ingestPort, atlantisPort: p.atlantisPort,
      certificateSha256: p.certificateSha256,
    },
    deviceToken: p.deviceToken,
  } as unknown as CollectorIdentity;
  return toQrPairing(idish, certPort);
}

// The exact string the QR encodes (compact JSON), and the module matrix — exposed so
// a test can compare the matrix against encodeQr of the expected payload.
export const qrPayload = (p: PairingResponse): string => JSON.stringify(buildQrPairing(p));
export const qrMatrix = (p: PairingResponse): boolean[][] => encodeQr(qrPayload(p));

// The human-typed short code: first 6 hex of the cert fingerprint, grouped 3+3.
function shortCode(sha256: string): string {
  const hex = sha256.slice(0, 6).toUpperCase();
  return `${hex.slice(0, 3)} ${hex.slice(3, 6)}`;
}

export async function runPair(ctx: Ctx): Promise<number> {
  const p = await getJson<PairingResponse>(ctx.config, '/api/pairing');

  const c = ctx.colors;
  // The deviceToken warning always goes to stderr so stdout carries only the payload
  // (the blob to paste, or the QR), safe to pipe or redirect.
  const tokenWarning = 'WARNING: this contains the device token — anyone who has it can capture this device. Do not share.';

  // Pairing-host drift warning (from the collector's boot check): the advertised host
  // is not covered by the cert SAN, so devices may fail to connect. To stderr in every
  // mode so it never pollutes the pipeable stdout payload.
  if (p.pairingHostWarning) errline(ctx, c.yellow(p.pairingHostWarning));

  if (flagBool(ctx.flags, 'json')) {
    jsonLine(ctx, buildQrPairing(p));
    errline(ctx, c.red(tokenWarning));
    return 0;
  }

  if (flagBool(ctx.flags, 'qr')) {
    for (const l of qrLines(qrMatrix(p), { color: c.enabled })) line(ctx, l);
    errline(ctx, c.red(tokenWarning));
    return 0;
  }

  line(ctx, c.bold('Pair a device'));
  line(ctx, `  address        ${p.host}:${p.ingestPort}`);
  line(ctx, `  pairing code   ${c.bold(shortCode(p.certificateSha256))}  ${c.dim('(rotates on collector restart)')}`);
  line(ctx, `  cert sha256    ${p.certificateSha256}`);
  line(ctx, '');
  line(ctx, c.dim('  terminus pair --qr    render a scannable QR (contains the device token)'));
  line(ctx, c.dim('  terminus pair --json  print the pairing blob to paste into the app'));
  return 0;
}
