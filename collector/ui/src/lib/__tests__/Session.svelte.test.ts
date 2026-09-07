import { describe, it, expect, vi, afterEach } from 'vitest';
import { Session } from '../state/Session.svelte.js';
import { Store } from '../state/Store.svelte.js';
import { BodyCache } from '../bodyCache.js';
import { Selection } from '../state/Selection.svelte.js';
import { Sockets } from '../state/Sockets.svelte.js';
import { teardownOnLogout } from '../session/logout.js';
import type { Client } from '../ws/Client.svelte.js';
import type { BodyRef, EntrySummary } from '../protocol.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const absent: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };
const entry: EntrySummary = {
  id: 'r1', deviceId: 'd1', source: 'atlantis', startedAt: 1, method: 'GET',
  url: 'https://api.test/thing', status: 200, durationMs: 3, error: null,
  requestBody: absent, responseBody: absent,
};

describe('Session.boot', () => {
  it('strips the token fragment (replaceState) before the login request and lands ready', async () => {
    window.location.hash = '#token=abc';
    const replace = vi.spyOn(window.history, 'replaceState');
    const fetchMock = vi.fn(async () => ({ status: 204 } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const s = new Session();
    await s.boot();

    expect(replace).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
    // replaceState must run before the token ever leaves in a request.
    expect(replace.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    expect(s.status).toBe('ready');
  });

  it('falls to the login screen when the token exchange fails and no cookie is valid', async () => {
    window.location.hash = '#token=bad';
    vi.spyOn(window.history, 'replaceState');
    // POST /api/session → 401 (login fails); GET /api/devices → 401 (probe fails).
    const fetchMock = vi.fn(async () => ({ status: 401 } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const s = new Session();
    await s.boot();

    expect(s.status).toBe('login');
  });

  it('accepts an existing cookie via probe when there is no token', async () => {
    window.location.hash = '';
    const fetchMock = vi.fn(async () => ({ status: 200 } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const s = new Session();
    await s.boot();

    expect(s.status).toBe('ready');
  });
});

describe('Session.logout', () => {
  it('fires onLogout (to tear the socket down) and lands on login/closed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 204 } as Response)));
    const s = new Session();
    const onLogout = vi.fn();
    s.onLogout = onLogout;

    await s.logout();

    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(s.status).toBe('login');
    expect(s.connection).toBe('closed');
  });

  // C5: logout wipes captured session data. This wires the REAL teardown
  // (session/logout.ts, exactly as main.ts does) to Session.onLogout and asserts
  // the effect through the real logout path — no reimplementation of the handler.
  it('runs the real teardownOnLogout through Session.onLogout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 204 } as Response)));
    const store = new Store();
    const cache = new BodyCache();
    const api = {
      fetchEntryDetail: vi.fn(async () => null),
      fetchBody: vi.fn(async () => ({ kind: 'gone' }) as const),
      fetchFrames: vi.fn(async () => ({ items: [], nextCursor: null })),
      fetchFrameBody: vi.fn(async () => ({ kind: 'gone' }) as const),
    };
    const selection = new Selection({ store, cache, api });
    const sockets = new Sockets({ store, cache, api });
    store.apply([{ type: 'entry', entry }]);
    cache.putRaw('h1', '{"a":1}');
    expect(store.entries.length).toBe(1);
    expect(cache.retainedBytes).toBeGreaterThan(0);

    const disconnect = vi.fn();
    const client = { disconnect } as unknown as Client;
    const s = new Session();
    s.onLogout = () => teardownOnLogout({ client, store, cache, selection, sockets });
    await s.logout();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(store.entries.length).toBe(0);
    expect(store.arrivals).toBe(0);
    expect(cache.retainedBytes).toBe(0);
  });
});
