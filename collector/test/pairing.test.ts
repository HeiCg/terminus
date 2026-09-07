import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateIdentity, toPairingImport, acquireStateLock, generateCertificate } from '../src/security/identity.js';
import { rotateIdentity, parseRotateArgs } from '../src/security/identityCli.js';
import { isPairingImport, isPublicPairing, isDeviceToken } from '../src/security/types.js';
import { createCollectorHarness } from './fixtures/harness.js';

const dirs: string[] = [];
async function tmp(): Promise<string> { const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-id-')); dirs.push(d); return d; }
afterEach(async () => { while (dirs.length) await fsp.rm(dirs.pop()!, { recursive: true, force: true }); });

describe('collector identity (R1)', () => {
  it('creates, persists and reloads a stable identity', async () => {
    const d = await tmp();
    const a = await loadOrCreateIdentity(d, { host: 'localhost', keyBits: 2048 });
    expect(a.collectorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(isDeviceToken(a.deviceToken)).toBe(true);
    // Restart: same dir preserves collectorId + deviceToken (device pairing survives).
    const b = await loadOrCreateIdentity(d, { host: 'localhost', keyBits: 2048 });
    expect(b.collectorId).toBe(a.collectorId);
    expect(b.deviceToken).toBe(a.deviceToken);
    expect(b.certificateSha256).toBe(a.certificateSha256);
  });

  it('writes the state dir 0700 and the key/token 0600', async () => {
    const d = await tmp();
    await loadOrCreateIdentity(d, { host: 'localhost', keyBits: 2048 });
    expect(fs.statSync(d).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(d, 'key.pem')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(d, 'device-token')).mode & 0o777).toBe(0o600);
  });

  it('does not leak the private key into the public pairing', async () => {
    const d = await tmp();
    const id = await loadOrCreateIdentity(d, { host: 'localhost', keyBits: 2048 });
    const json = JSON.stringify(id.publicPairing);
    expect(json).not.toContain('PRIVATE KEY');
    expect(Object.keys(id.publicPairing)).not.toContain('privateKeyPem');
  });

  it('refuses to silently replace an expired identity', async () => {
    const d = await tmp();
    await fsp.mkdir(d, { recursive: true, mode: 0o700 });
    // A normal short-lived cert (portable: no backdating flags), aged out by injecting
    // a clock far past its notAfter rather than generating an already-expired cert.
    const { certPem, keyPem } = await generateCertificate(d, { host: 'localhost', ips: ['127.0.0.1'], days: 1, keyBits: 2048 });
    await fsp.writeFile(path.join(d, 'cert.pem'), certPem);
    await fsp.writeFile(path.join(d, 'key.pem'), keyPem);
    await fsp.writeFile(path.join(d, 'device-token'), 'x');
    await fsp.writeFile(path.join(d, 'identity.json'), JSON.stringify({ collectorId: '00000000-0000-4000-8000-000000000000', host: 'localhost', generation: 1 }));
    const tenYears = () => Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
    await expect(loadOrCreateIdentity(d, { host: 'localhost', keyBits: 2048, now: tenYears })).rejects.toThrow(/expired/i);
  });

  it('refuses a mismatched key/cert pair with an actionable error (IMPORTANT 5)', async () => {
    const d = await tmp();
    await fsp.mkdir(d, { recursive: true, mode: 0o700 });
    // Two independent identities; keep A's cert but B's key → they do not pair.
    const a = await generateCertificate(d, { host: 'localhost', ips: ['127.0.0.1'], keyBits: 2048 });
    const b = await generateCertificate(d, { host: 'localhost', ips: ['127.0.0.1'], keyBits: 2048 });
    await fsp.writeFile(path.join(d, 'cert.pem'), a.certPem);
    await fsp.writeFile(path.join(d, 'key.pem'), b.keyPem);
    await fsp.writeFile(path.join(d, 'device-token'), 'x'.repeat(43));
    await fsp.writeFile(path.join(d, 'identity.json'), JSON.stringify({ collectorId: '00000000-0000-4000-8000-000000000000', host: 'localhost', generation: 1 }));
    await expect(loadOrCreateIdentity(d, { host: 'localhost' })).rejects.toThrow(/do not match/i);
  });

  it('produces a structurally valid PairingImport (no private material)', async () => {
    const d = await tmp();
    const id = await loadOrCreateIdentity(d, { host: 'localhost', ingestPort: 8788, atlantisPort: 10909, keyBits: 2048 });
    const pairing = toPairingImport(id);
    expect(isPairingImport(pairing)).toBe(true);
    expect(isPublicPairing(pairing)).toBe(true);
    expect(pairing.certificateSha256).toBe(id.certificateSha256);
    expect(JSON.stringify(pairing)).not.toContain('PRIVATE KEY');
  });
});

describe('identity:rotate', () => {
  it('parses host and repeated --ip flags', () => {
    const a = parseRotateArgs(['--host', 'mac.local', '--ip', '10.0.0.2', '--ip', '10.0.0.3', '--state-dir', '/x']);
    expect(a.host).toBe('mac.local');
    expect(a.ips).toEqual(['10.0.0.2', '10.0.0.3']);
    expect(a.stateDir).toBe('/x');
  });

  it('rejects an invalid host before touching openssl', async () => {
    await expect(rotateIdentity(['--host', 'bad host;rm -rf /', '--state-dir', await tmp()])).rejects.toThrow(/invalid host/);
  });

  it('rotates to a new identity and device token, bumping generation', async () => {
    const d = await tmp();
    const before = await loadOrCreateIdentity(d, { host: 'localhost', keyBits: 2048 });
    const after = await rotateIdentity(['--host', 'localhost', '--state-dir', d]);
    expect(after.generation).toBe(before.generation + 1);
    expect(after.collectorId).not.toBe(before.collectorId);
    const reloaded = await loadOrCreateIdentity(d, { host: 'localhost' });
    expect(reloaded.deviceToken).not.toBe(before.deviceToken);
    expect(reloaded.collectorId).toBe(after.collectorId);
  });

  it('refuses to rotate while the state dir is locked by a live process', async () => {
    const d = await tmp();
    await loadOrCreateIdentity(d, { host: 'localhost', keyBits: 2048 });
    const release = await acquireStateLock(d);
    try {
      await expect(rotateIdentity(['--host', 'localhost', '--state-dir', d])).rejects.toThrow(/locked by a running collector/);
    } finally {
      await release();
    }
  });

  it('leaves the old identity intact when a write is interrupted before rename', async () => {
    const d = await tmp();
    const before = await loadOrCreateIdentity(d, { host: 'localhost', keyBits: 2048 });
    // Simulate a half-written rotation: a stray temp file, never renamed into place.
    await fsp.writeFile(path.join(d, '.cert.pem.999.dead.tmp'), 'garbage');
    const reloaded = await loadOrCreateIdentity(d, { host: 'localhost' });
    expect(reloaded.collectorId).toBe(before.collectorId);
    expect(reloaded.deviceToken).toBe(before.deviceToken);
  });
});

describe('GET /api/pairing', () => {
  it('requires auth, sets no-store, and returns the PairingImport', async () => {
    const d = await tmp();
    const id = await loadOrCreateIdentity(d, { host: 'localhost', ingestPort: 8788, atlantisPort: 10909, keyBits: 2048 });
    const h = await createCollectorHarness({ getPairing: () => toPairingImport(id) });
    try {
      // Unauthenticated is rejected.
      expect((await fetch(h.url + '/api/pairing')).status).toBe(401);
      const cookie = await h.login();
      const res = await fetch(h.url + '/api/pairing', { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(isPairingImport(body)).toBe(true);
      expect(body.deviceToken).toBe(id.deviceToken);
    } finally {
      await h.close();
    }
  });
});
