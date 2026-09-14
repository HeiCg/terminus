import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createIdentity, certExpiryWarning, CERT_EXPIRY_WARN_MS } from '../src/security/identity.js';
import type { CollectorIdentity } from '../src/security/types.js';

const DAY = 24 * 60 * 60 * 1000;

// A real fixture identity (365-day cert). The warning is checked against an injected
// clock rather than a doctored cert, which openssl will not backdate.
let identity: CollectorIdentity;
let dir: string;
beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-expiry-'));
  identity = await createIdentity(dir, { host: 'localhost', ips: ['127.0.0.1', '::1'], generation: 1, keyBits: 2048 }, { ingestPort: 8788, atlantisPort: 10909 });
});
afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

describe('certExpiryWarning (T5.3)', () => {
  it('returns null while well outside the 30-day threshold', () => {
    expect(certExpiryWarning(identity, identity.notBefore)).toBeNull();
    expect(certExpiryWarning(identity, identity.notAfter - 40 * DAY)).toBeNull();
  });

  it('warns within 30 days of expiry, naming the date and the rotate command', () => {
    const w = certExpiryWarning(identity, identity.notAfter - 20 * DAY);
    expect(w).not.toBeNull();
    expect(w).toContain('identity:rotate');
    expect(w).toContain(new Date(identity.notAfter).toISOString());
    expect(w).toContain('expires on');
  });

  it('warns that it has already expired past notAfter', () => {
    const w = certExpiryWarning(identity, identity.notAfter + DAY);
    expect(w).not.toBeNull();
    expect(w).toContain('has expired');
  });

  it('honours a custom threshold', () => {
    // A one-day threshold: 20 days out is fine, one hour out warns.
    expect(certExpiryWarning(identity, identity.notAfter - 20 * DAY, DAY)).toBeNull();
    expect(certExpiryWarning(identity, identity.notAfter - 3600_000, DAY)).not.toBeNull();
    expect(CERT_EXPIRY_WARN_MS).toBe(30 * DAY);
  });
});
