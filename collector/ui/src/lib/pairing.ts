import type { PairingInfo } from './api.js';

// Build the string the QR encodes: the collector's `QrPairing` — the full v2
// identity minus the ~1.4 KB DER, plus certPort — as compact single-line JSON.
//
// Key order is fixed to the shared fixture in
// docs/superpowers/specs/2026-09-04-terminus-qr-pairing.md § Fixture compartilhada
// (version, collectorId, host, certPort, ingestPort, atlantisPort,
// certificateSha256, deviceToken). The app compares the decoded blob against the
// same literal, so the serialized bytes — order included — are the contract.
//
// This mirrors the server's `toQrPairing`; a parity test pins both against the
// fixture. `certPort` falls back to the default LAN cert-listener port when an
// older collector omits it, so the QR is never emitted without a port for
// /api/cert.
export function buildQrPayload(p: PairingInfo): string {
  return JSON.stringify({
    version: 2,
    collectorId: p.collectorId,
    host: p.host,
    certPort: p.certPort ?? 8789,
    ingestPort: p.ingestPort,
    atlantisPort: p.atlantisPort,
    certificateSha256: p.certificateSha256,
    deviceToken: p.deviceToken,
  });
}
