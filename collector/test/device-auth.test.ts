import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { createIngestShared, createDeviceServer } from '../src/deviceServer.js';
import { createIdentity } from '../src/security/identity.js';
import { verifyDeviceToken, bearer, tlsServerOptions } from '../src/security/deviceAuth.js';
import { log } from '../src/log.js';
import type { CollectorIdentity } from '../src/security/types.js';

// A raw TLS upgrade to /ingest carrying a chosen Authorization header (or none),
// resolving with the HTTP status the server writes back before any WS handshake.
function upgradeStatus(port: number, ca: string, authorization: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, ca: [ca], servername: 'localhost', rejectUnauthorized: true }, () => {
      const authLine = authorization != null ? `Authorization: ${authorization}\r\n` : '';
      s.write(
        `GET /ingest HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${authLine}\r\n`,
      );
    });
    let buf = '';
    let done = false;
    s.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m && !done) { done = true; resolve(Number(m[1])); s.destroy(); }
    });
    s.on('error', (e) => { if (!done) reject(e); });
    s.on('close', () => { if (!done) reject(new Error('closed without an HTTP response')); });
  });
}

describe('WSS device auth rejection logging (T1.2)', () => {
  let identity: CollectorIdentity;
  let dir: string;
  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nc-auth-'));
    identity = await createIdentity(dir, { host: 'localhost', ips: ['127.0.0.1', '::1'], generation: 1, keyBits: 2048 }, { ingestPort: 8788, atlantisPort: 10909 });
  });
  afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  it('returns 401, tallies rejectedDeviceAuth, and logs a rate-limited warn without the token', async () => {
    const store = new Store();
    const shared = createIngestShared();
    const device = createDeviceServer(store, identity, shared);
    await new Promise<void>((r) => device.server.listen(0, '127.0.0.1', () => r()));
    const port = (device.server.address() as net.AddressInfo).port;
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      // A wrong token and an absent token both refuse with 401.
      expect(await upgradeStatus(port, identity.certificatePem, 'Bearer wrong-secret-token')).toBe(401);
      expect(await upgradeStatus(port, identity.certificatePem, null)).toBe(401);

      // The counter counts every rejection (it is not rate-limited).
      expect(shared.scheduler.stats().rejectedDeviceAuth).toBe(2);

      // Both rejections came from 127.0.0.1 inside the 10 s window, so the warn is
      // emitted at most once for that remote (reconnect-loop flood protection).
      expect(warn).toHaveBeenCalledTimes(1);
      const [msg, remote] = warn.mock.calls[0];
      expect(String(msg)).toContain('rejected device auth');
      expect(String(msg)).toMatch(/token (invalid|absent)/);
      expect(remote).toBe('127.0.0.1');
      // The token bytes are never logged.
      const logged = warn.mock.calls.map((c) => c.map(String).join(' ')).join(' ');
      expect(logged).not.toContain('wrong-secret-token');
    } finally {
      warn.mockRestore();
      device.close();
      await new Promise<void>((r) => device.server.close(() => r()));
    }
  });
});

describe('deviceAuth primitives (T5.7)', () => {
  it('verifyDeviceToken accepts the exact token', () => {
    expect(verifyDeviceToken('s3cret-token', 's3cret-token')).toBe(true);
  });

  it('rejects a candidate of a different length without throwing (guards timingSafeEqual)', () => {
    expect(verifyDeviceToken('short', 'a-longer-token')).toBe(false);
    expect(verifyDeviceToken('a-longer-token-x', 'a-longer-token')).toBe(false);
  });

  it('rejects an empty, null, or undefined candidate', () => {
    expect(verifyDeviceToken('', 'a-longer-token')).toBe(false);
    expect(verifyDeviceToken(null, 'a-longer-token')).toBe(false);
    expect(verifyDeviceToken(undefined, 'a-longer-token')).toBe(false);
  });

  it('rejects a same-length but different token without throwing', () => {
    // Equal length exercises the constant-time compare rather than the length guard.
    expect(verifyDeviceToken('aaaaaa', 'bbbbbb')).toBe(false);
  });

  it('bearer extracts a Bearer token and returns null otherwise', () => {
    expect(bearer('Bearer tok-123')).toBe('tok-123');
    expect(bearer('bearer tok-123')).toBeNull(); // scheme is case-sensitive
    expect(bearer('Basic Zm9v')).toBeNull();
    expect(bearer('')).toBeNull();
    expect(bearer(undefined)).toBeNull();
  });

  it('tlsServerOptions pins a TLS 1.2 floor with the identity cert/key and a handshake deadline', () => {
    const fakeIdentity = { privateKeyPem: 'THE-KEY', certificatePem: 'THE-CERT' } as unknown as CollectorIdentity;
    const o = tlsServerOptions(fakeIdentity);
    expect(o.minVersion).toBe('TLSv1.2');
    expect(o.key).toBe('THE-KEY');
    expect(o.cert).toBe('THE-CERT');
    expect(o.handshakeTimeout).toBeGreaterThan(0);
    expect(o.ciphers).toContain('ECDHE');
  });
});
