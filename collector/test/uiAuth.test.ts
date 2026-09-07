import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createUiAuth, SESSION_COOKIE } from '../src/security/uiAuth.js';

const ADMIN = 'admin-token-abc';
const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    ended: false,
    writeHead(code: number, h?: Record<string, string>) { res.statusCode = code; if (h) Object.assign(res.headers, h); return res; },
    end() { res.ended = true; return res; },
  };
  return res as unknown as ServerResponse & typeof res;
}

// Log in and return the `nc_session=…` cookie header the browser would echo back.
function login(auth: ReturnType<typeof createUiAuth>, headers: Record<string, string> = {}) {
  const res = fakeRes();
  auth.createSession(req({ authorization: `Bearer ${ADMIN}`, ...headers }), res);
  expect(res.statusCode).toBe(204);
  return res.headers['set-cookie'].split(';')[0];
}

describe('createUiAuth', () => {
  it('issues an HttpOnly SameSite=Strict cookie and authorizes it', () => {
    const auth = createUiAuth({ adminToken: ADMIN });
    const res = fakeRes();
    auth.createSession(req({ authorization: `Bearer ${ADMIN}` }), res);
    expect(res.statusCode).toBe(204);
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);
    const cookie = setCookie.split(';')[0];
    expect(auth.authorize(req({ cookie }))).toMatchObject({ ok: true, kind: 'session' });
  });

  it('rejects a bad admin bearer with 401', () => {
    const auth = createUiAuth({ adminToken: ADMIN });
    const res = fakeRes();
    auth.createSession(req({ authorization: 'Bearer wrong' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('expires a session at the 12h absolute clock even while kept active', () => {
    let t = 1_000_000;
    const auth = createUiAuth({ adminToken: ADMIN, now: () => t });
    const cookie = login(auth);
    // Touch every 29min so the idle clock never trips; only the absolute cap can.
    const step = 29 * 60 * 1000;
    let elapsed = 0;
    while (elapsed + step < 12 * 60 * 60 * 1000) {
      t += step; elapsed += step;
      expect(auth.authorize(req({ cookie })).ok).toBe(true);
    }
    // lastSeen is <30min old, but total age crosses 12h → absolute expiry.
    t += (12 * 60 * 60 * 1000 - elapsed) + 1;
    expect(auth.authorize(req({ cookie })).ok).toBe(false);
  });

  it('expires a session at the 30min idle clock and slides on use', () => {
    let t = 5_000_000;
    const auth = createUiAuth({ adminToken: ADMIN, now: () => t });
    const cookie = login(auth);
    t += 20 * 60 * 1000;               // 20min idle: still valid, refreshes lastSeen
    expect(auth.authorize(req({ cookie })).ok).toBe(true);
    t += 20 * 60 * 1000;               // 20min after the refresh: still under 30min
    expect(auth.authorize(req({ cookie })).ok).toBe(true);
    t += 31 * 60 * 1000;               // 31min idle since last touch: expired
    expect(auth.authorize(req({ cookie })).ok).toBe(false);
  });

  it('revokes a session so its cookie no longer authorizes', () => {
    const auth = createUiAuth({ adminToken: ADMIN });
    const cookie = login(auth);
    expect(auth.authorize(req({ cookie })).ok).toBe(true);
    const sid = auth.revokeSession(req({ cookie }));
    expect(sid).toBeTruthy();
    expect(auth.authorize(req({ cookie })).ok).toBe(false);
  });

  it('caps the table at 16 sessions, evicting the least-recently-seen', () => {
    let t = 1;
    const auth = createUiAuth({ adminToken: ADMIN, now: () => t });
    const first = login(auth); t += 1;
    for (let i = 0; i < 15; i++) { login(auth); t += 1; } // table now full at 16
    login(auth);                                          // 17th evicts the oldest (first)
    expect(auth.authorize(req({ cookie: first })).ok).toBe(false);
  });
});
