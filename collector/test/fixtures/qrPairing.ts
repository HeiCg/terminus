// The QR pairing fixture, copied verbatim from
// docs/superpowers/specs/2026-09-04-terminus-qr-pairing.md § Fixture compartilhada.
// The SAME literal lives in the app repo's test suite so a QR the collector emits
// (F4) is proven to parse on the app side (G2). Do not reformat: byte-for-byte
// equality with the app copy is the cross-repo contract, and key order matters
// because both sides compare the serialized string.
export const QR_PAIRING_FIXTURE =
  '{"version":2,"collectorId":"6f1c2b0e-3b7a-4c1d-9e2f-0a1b2c3d4e5f","host":"192.168.0.10","certPort":8789,"ingestPort":8788,"atlantisPort":10909,"certificateSha256":"0000000000000000000000000000000000000000000000000000000000000000","deviceToken":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}';

// The decoded fields of the fixture, for building a matching identity/pairing in
// tests without re-typing the literal.
export const QR_PAIRING_FIXTURE_FIELDS = JSON.parse(QR_PAIRING_FIXTURE) as {
  version: 2;
  collectorId: string;
  host: string;
  certPort: number;
  ingestPort: number;
  atlantisPort: number;
  certificateSha256: string;
  deviceToken: string;
};
