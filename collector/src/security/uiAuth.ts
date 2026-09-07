import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Absolute lifetime and idle window for a UI session; a session dies at whichever
// comes first. Restart drops every session (state is in-memory) and rotates the
// adminToken, so a bounced collector forces re-login.
const SESSION_MAX_MS = 12 * 60 * 60 * 1000; // 12h
const SESSION_IDLE_MS = 30 * 60 * 1000;     // 30min
const MAX_SESSIONS = 16;
export const SESSION_COOKIE = 'nc_session';

export type Authz =
  | { ok: true; kind: 'session'; sid: string }
  | { ok: true; kind: 'bearer' }
  | { ok: false; status: 401 };

export interface UiAuth {
  // Classify a request as an authenticated session, an admin bearer, or neither.
  authorize(req: IncomingMessage): Authz;
  // Exchange a valid admin bearer for a session cookie (204 + Set-Cookie) or 401.
  createSession(req: IncomingMessage, res: ServerResponse): void;
  // Drop the session named by the request cookie; returns its id so the caller
  // can close that session's live sockets.
  revokeSession(req: IncomingMessage): string | null;
}

interface Session { createdAt: number; lastSeen: number; }

function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer (.+)$/.exec(h);
  return m ? m[1] : null;
}

function cookieSid(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

// Length-checked constant-time compare; timingSafeEqual throws on length mismatch.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function createUiAuth(
  { adminToken, now = Date.now }: { adminToken: string; now?: () => number },
): UiAuth {
  const sessions = new Map<string, Session>();

  const expired = (s: Session, t: number): boolean =>
    t - s.createdAt > SESSION_MAX_MS || t - s.lastSeen > SESSION_IDLE_MS;

  // Return the live session id for this request, refreshing its idle clock.
  function touchSession(req: IncomingMessage): string | null {
    const sid = cookieSid(req);
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s) return null;
    const t = now();
    if (expired(s, t)) { sessions.delete(sid); return null; }
    s.lastSeen = t;
    return sid;
  }

  function verifyBearer(req: IncomingMessage): boolean {
    const tok = bearerToken(req);
    return tok != null && safeEqual(tok, adminToken);
  }

  return {
    authorize(req) {
      const sid = touchSession(req);
      if (sid) return { ok: true, kind: 'session', sid };
      if (verifyBearer(req)) return { ok: true, kind: 'bearer' };
      return { ok: false, status: 401 };
    },
    createSession(req, res) {
      if (!verifyBearer(req)) { res.writeHead(401); res.end(); return; }
      const t = now();
      for (const [id, s] of sessions) if (expired(s, t)) sessions.delete(id);
      // Cap the table; evict the least-recently-seen session to make room.
      while (sessions.size >= MAX_SESSIONS) {
        let oldest: string | null = null;
        let oldestT = Infinity;
        for (const [id, s] of sessions) if (s.lastSeen < oldestT) { oldestT = s.lastSeen; oldest = id; }
        if (oldest == null) break;
        sessions.delete(oldest);
      }
      const sid = randomBytes(18).toString('base64url');
      sessions.set(sid, { createdAt: t, lastSeen: t });
      const maxAge = Math.floor(SESSION_MAX_MS / 1000);
      res.writeHead(204, {
        'set-cookie': `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
      });
      res.end();
    },
    revokeSession(req) {
      const sid = cookieSid(req);
      if (sid && sessions.delete(sid)) return sid;
      return null;
    },
  };
}
