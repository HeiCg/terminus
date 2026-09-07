// The dependency-free QR encoder moved to a Svelte-free shared module at
// collector/src/security/qr.ts so the Terminus CLI can render the same pairing
// QR this UI does, from one implementation. Re-exported here so the existing UI
// imports (`../qr.js`, PairingCard) and the encoder's own test keep resolving.
export { encodeQr } from '../../../src/security/qr.js';
