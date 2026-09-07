import { login, logout, probeSession } from '../api.js';

// Session owns the browser's auth lifecycle and the socket's liveness flags the
// shell renders. `status` drives the top-level view switch (login vs shell);
// `connection` (fed by the Client) drives the connection indicator; `paused`
// mirrors the broadcaster's pause. `boot` runs once at startup: it trades the
// URL-fragment admin token for a cookie — stripping the fragment BEFORE any
// request so the token never leaves in a header while still in the address bar —
// and otherwise falls back to an existing cookie.
export type Status = 'boot' | 'authenticating' | 'login' | 'ready';
export type Connection = 'connecting' | 'open' | 'reconnecting' | 'closed';

export class Session {
  status = $state<Status>('boot');
  connection = $state<Connection>('connecting');
  reconnectAttempt = $state(0);
  paused = $state(false);
  error = $state<string | null>(null);

  // Fired when the session becomes authenticated (from boot or a manual login).
  // main.ts wires this to Client.connect() so the socket opens on either path
  // without a reactive effect (banned) watching `status`.
  onReady: (() => void) | null = null;

  // Fired on logout so the socket can be torn down. Session holds no Client
  // reference; main.ts wires this to Client.disconnect(), mirroring onReady.
  onLogout: (() => void) | null = null;

  private ready(): void {
    this.status = 'ready';
    this.onReady?.();
  }

  async boot(): Promise<void> {
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    // Strip the fragment FIRST, before any await — the token must not survive in
    // the address bar (or a later reload) once we hold it.
    history.replaceState(null, '', location.pathname + location.search);
    this.status = 'authenticating';
    if (token && (await login(token))) { this.ready(); return; }
    if (await probeSession()) { this.ready(); return; }
    this.status = 'login';
  }

  async submitToken(t: string): Promise<void> {
    const token = t.trim();
    if (!token) return;
    this.error = null;
    this.status = 'authenticating';
    if (await login(token)) { this.ready(); return; }
    this.status = 'login';
    this.error = 'Token inválido.';
  }

  async logout(): Promise<void> {
    await logout();
    this.onLogout?.(); // tear the socket down before we flip to the login screen
    this.connection = 'closed';
    this.status = 'login';
  }
}
