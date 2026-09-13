import { describe, it, expect } from 'vitest';
import { startCli, waitUntil, createFakeUiServer, snapshotEntry, snapshotMessage } from './helpers.js';

// A fast, deterministic backoff so a reconnect happens within a test tick.
const FAST = { TERMINUS_RECONNECT_MIN_MS: '5', TERMINUS_RECONNECT_MAX_MS: '20' };

function envFor(port: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { TERMINUS_HOST: '127.0.0.1', TERMINUS_PORT: String(port), TERMINUS_TOKEN: 't', ...FAST, ...extra };
}

const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe('tail reconnect', () => {
  it('reconnects after an unsolicited close and prints only entries new since the drop', async () => {
    // Connection 1 carries /pre; the reconnect's snapshot repeats /pre and adds /new.
    const server = await createFakeUiServer((n, sock) => {
      if (n === 1) sock.send(JSON.stringify(snapshotMessage([snapshotEntry({ id: 'pre', url: 'https://api.example.com/pre' })])));
      else sock.send(JSON.stringify(snapshotMessage([
        snapshotEntry({ id: 'pre', url: 'https://api.example.com/pre' }),
        snapshotEntry({ id: 'new', method: 'DELETE', url: 'https://api.example.com/new' }),
      ])));
    });
    const controller = new AbortController();
    const { done, out, err } = startCli(['tail', '--last', '10'], { env: envFor(server.port), signal: controller.signal });
    try {
      await waitUntil(() => out().includes('/pre'));
      server.drop();                                   // unsolicited close → reconnect
      await waitUntil(() => out().includes('/new'));
      await waitUntil(() => server.connections() >= 2);

      controller.abort();
      const r = await done;
      expect(r.code).toBe(0);
      // /pre was shown on the first snapshot and NOT reprinted by the reconnect one.
      expect(occurrences(out(), '/pre')).toBe(1);
      expect(out()).toContain('DELETE');               // the new entry rendered
      expect(err()).toContain('reconnecting');
      expect(err()).toContain('reconnected');
    } finally { controller.abort(); await done; await server.close(); }
  });

  it('--json emits a reconnect event line rather than human text', async () => {
    const server = await createFakeUiServer((_n, sock) => {
      sock.send(JSON.stringify(snapshotMessage([snapshotEntry({ id: 'pre', url: 'https://api.example.com/pre' })])));
    });
    const controller = new AbortController();
    const { done, out } = startCli(['tail', '--json'], { env: envFor(server.port), signal: controller.signal });
    try {
      await waitUntil(() => out().includes('"type":"snapshot"'));
      server.drop();
      await waitUntil(() => out().includes('"event":"reconnect"'));
      await waitUntil(() => server.connections() >= 2);

      controller.abort();
      await done;
      const events = out().trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const reconnect = events.filter((e) => e.event === 'reconnect');
      expect(reconnect.length).toBeGreaterThanOrEqual(1);
      expect(reconnect.some((e) => e.state === 'reconnecting')).toBe(true);
    } finally { controller.abort(); await done; await server.close(); }
  });

  it('--no-reconnect exits 3 on an unsolicited close', async () => {
    const server = await createFakeUiServer((_n, sock) => {
      sock.send(JSON.stringify(snapshotMessage([])));
    });
    const controller = new AbortController(); // never aborted: the close is the server's
    const { done } = startCli(['tail', '--no-reconnect'], { env: envFor(server.port), signal: controller.signal });
    try {
      await new Promise((r) => setTimeout(r, 60));
      server.drop();
      const r = await done;
      expect(r.code).toBe(3);
      expect(r.stderr).toContain('collector closed the connection');
      expect(server.connections()).toBe(1); // never retried
    } finally { await server.close(); }
  });
});
