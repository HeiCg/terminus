import type { EntryDetail, FrameSummary, Page } from './protocol.js';

// All collector calls ride the session cookie same-origin — the admin token is
// traded for a cookie once (Session.boot) and never travels a request again, and
// mutations get their Origin from the browser automatically. Every helper here
// swallows transport errors into a benign value so a dropped fetch never throws
// into a component; the socket, not these, is the source of truth for liveness.

const enc = encodeURIComponent;
const SAME_ORIGIN: RequestInit = { credentials: 'same-origin' };

// One HTTP exchange body loaded on demand: the bytes (utf8 text), an omission
// reason (410, the reason from x-body-omitted), gone (404, the record was cleared
// out from under the selection), or error (a transport failure or 5xx — a
// RECOVERABLE fault the UI offers to retry, never conflated with a 404).
export type BodyFetch =
  | { kind: 'ok'; text: string }
  | { kind: 'omitted'; reason: string }
  | { kind: 'gone' }
  | { kind: 'error' };

export type PairingInfo = {
  version: 2; collectorId: string; host: string; ingestPort: number; atlantisPort: number;
  certificateDerBase64: string; certificateSha256: string; deviceToken: string;
  // Additive (F3): the LAN cert listener's port, echoed so the QR can point the app
  // at GET /api/cert. Optional for back-compat with an older collector.
  certPort?: number;
};

// Trade an admin bearer for the session cookie. Returns true on 204; any other
// status or a transport error is a failed exchange (the caller lands on login).
export async function login(token: string): Promise<boolean> {
  try {
    const r = await fetch('/api/session', {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, credentials: 'same-origin',
    });
    return r.status === 204;
  } catch { return false; }
}

// Drop the session cookie. Best-effort: a failure still lands the UI on login.
export async function logout(): Promise<void> {
  try { await fetch('/api/session', { method: 'DELETE', credentials: 'same-origin' }); } catch { /* ignore */ }
}

// A live cookie lets the data routes answer 200; used to confirm an existing
// cookie and to detect an expired/revoked one on reconnect without looping.
export async function probeSession(): Promise<boolean> {
  try { return (await fetch('/api/devices', SAME_ORIGIN)).status === 200; }
  catch { return false; }
}

export async function fetchEntryDetail(dev: string, id: string): Promise<EntryDetail | null> {
  try {
    const r = await fetch(`/api/entries/${enc(dev)}/${enc(id)}`, SAME_ORIGIN);
    if (!r.ok) return null;
    return await r.json() as EntryDetail;
  } catch { return null; }
}

export async function fetchBody(dev: string, id: string, side: 'request' | 'response'): Promise<BodyFetch> {
  try {
    const r = await fetch(`/api/entries/${enc(dev)}/${enc(id)}/body?side=${side}`, SAME_ORIGIN);
    if (r.status === 410) return { kind: 'omitted', reason: r.headers.get('x-body-omitted') ?? 'omitted' };
    if (r.status === 404) return { kind: 'gone' };
    if (!r.ok) return { kind: 'error' }; // 5xx and other faults are recoverable, not gone
    return { kind: 'ok', text: await r.text() };
  } catch { return { kind: 'error' }; } // transport failure: offer a retry, never gone
}

export async function fetchFrames(dev: string, wsId: string, after: number | null, limit: number): Promise<Page<FrameSummary>> {
  const qs = new URLSearchParams();
  if (after !== null) qs.set('after', String(after));
  qs.set('limit', String(limit));
  try {
    const r = await fetch(`/api/ws/${enc(dev)}/${enc(wsId)}/frames?${qs.toString()}`, SAME_ORIGIN);
    if (!r.ok) return { items: [], nextCursor: null };
    return await r.json() as Page<FrameSummary>;
  } catch { return { items: [], nextCursor: null }; }
}

export async function fetchFrameBody(dev: string, wsId: string, seq: number): Promise<BodyFetch> {
  try {
    const r = await fetch(`/api/ws/${enc(dev)}/${enc(wsId)}/frames/${seq}/body`, SAME_ORIGIN);
    if (r.status === 410) return { kind: 'omitted', reason: r.headers.get('x-body-omitted') ?? 'omitted' };
    if (r.status === 404) return { kind: 'gone' };
    if (!r.ok) return { kind: 'error' }; // 5xx and other faults are recoverable, not gone
    return { kind: 'ok', text: await r.text() };
  } catch { return { kind: 'error' }; } // transport failure: offer a retry, never gone
}

// Clear the capture store (optionally one device). THROWS on a non-2xx or a
// transport error — like setPaused — so the caller can surface a toast rather than
// silently swallowing a failed clear. Every caller must `.catch` the rejection.
export async function clear(device?: string): Promise<void> {
  const qs = device ? `?device=${enc(device)}` : '';
  const r = await fetch(`/api/clear${qs}`, { method: 'POST', credentials: 'same-origin' });
  if (!r.ok) throw new Error(`clear ${r.status}`);
}

// Toggle the live broadcaster's pause; returns the server's authoritative state.
// Throws on a non-2xx or transport error rather than echoing the requested value
// — the caller must keep the prior UI state, not flip to one the server never
// accepted.
export async function setPaused(paused: boolean): Promise<boolean> {
  const r = await fetch('/api/pause', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    credentials: 'same-origin', body: JSON.stringify({ paused }),
  });
  if (!r.ok) throw new Error(`pause ${r.status}`);
  return (await r.json() as { paused: boolean }).paused;
}

export async function fetchPairing(): Promise<PairingInfo | null> {
  try {
    const r = await fetch('/api/pairing', SAME_ORIGIN);
    if (!r.ok) return null; // 503 while the identity is not yet minted, or any error
    return await r.json() as PairingInfo;
  } catch { return null; }
}

// Export links are plain hrefs the browser follows with the cookie attached; the
// device scope is appended by the caller (a later task's toolbar).
export const exportUrl = (kind: 'har' | 'json'): string => (kind === 'har' ? '/export.har' : '/export.json');
