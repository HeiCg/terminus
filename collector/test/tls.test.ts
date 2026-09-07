import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTlsFixture, type TlsFixture } from './fixtures/tls.js';

let tls: TlsFixture;
beforeAll(async () => { tls = await createTlsFixture(); });
afterAll(async () => { await tls.close(); });

describe('TLS device ingest (R1)', () => {
  it('accepts the paired certificate with a valid token and ingests', async () => {
    const r = await tls.tryIngest({ certificate: 'paired', token: 'valid' });
    expect(r.ready).toBe(true);
    expect(r.entry).toBe(true);
  });

  it('sends {type:ready,protocolVersion:2} as the first WSS server frame', async () => {
    const r = await tls.tryIngest({ certificate: 'paired', token: 'valid' });
    expect(r.readyMessage).toEqual({ type: 'ready', protocolVersion: 2 });
  });

  it('rejects a client pinned to a different certificate (certificate_mismatch)', async () => {
    const r = await tls.tryIngest({ certificate: 'other', token: 'valid' });
    expect(r.ready).toBe(false);
  });

  it('rejects an expired server certificate (certificate_expired)', async () => {
    const r = await tls.tryIngest({ server: 'expired', certificate: 'expired', token: 'valid' });
    expect(r.ready).toBe(false);
  });

  it('rejects a hostname the certificate does not cover (hostname_mismatch)', async () => {
    const r = await tls.tryIngest({ certificate: 'paired', token: 'valid', servername: 'wrong.example' });
    expect(r.ready).toBe(false);
  });

  it('rejects a wrong device token with 401 even over a trusted TLS channel', async () => {
    const r = await tls.tryIngest({ certificate: 'paired', token: 'wrong' });
    expect(r.status).toBe(401);
    expect(r.ready).toBe(false);
  });

  it('exposes no admin/API route on the LAN listener', async () => {
    expect(await tls.readAdminRoute('/api/entries')).toBe(404);
    expect(await tls.readAdminRoute('/api/pairing')).toBe(404);
  });

  it('never ingests over a plaintext connection to the TLS port', async () => {
    expect(await tls.plaintextProducesEntry()).toBe(false);
  });

  it('matches the brief contract lines verbatim', async () => {
    expect((await tls.tryIngest({ certificate: 'paired', token: 'valid' })).ready).toBe(true);
    expect((await tls.tryIngest({ certificate: 'other', token: 'valid' })).ready).toBe(false);
    expect((await tls.tryIngest({ certificate: 'paired', token: 'wrong' })).status).toBe(401);
    expect(await tls.readAdminRoute('/api/entries')).toBe(404);
    expect(await tls.plaintextProducesEntry()).toBe(false);
  });
});
