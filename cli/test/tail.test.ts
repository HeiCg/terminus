import { describe, it, expect } from 'vitest';
import { createCollectorHarness } from '../../collector/test/fixtures/harness.js';
import { startCli, waitUntil, makeEntry } from './helpers.js';

describe('tail', () => {
  it('prints the snapshot then a live entry, and stops cleanly on abort', async () => {
    const h = await createCollectorHarness();
    try {
      // A pre-existing entry appears in the initial snapshot window.
      h.store.addEntry(makeEntry({ id: 'pre', method: 'GET', url: 'https://api.example.com/pre', status: 200 }));

      const controller = new AbortController();
      const { done, out } = startCli(['tail', '--last', '10'], { harness: h, signal: controller.signal });

      await waitUntil(() => out().includes('/pre'));

      // A new entry captured while tailing streams as a live line.
      h.store.addEntry(makeEntry({ id: 'live', method: 'DELETE', url: 'https://api.example.com/live', status: 204 }));
      await waitUntil(() => out().includes('/live'));

      controller.abort();
      const r = await done;
      expect(r.code).toBe(0);
      expect(out()).toContain('DELETE');
    } finally { await h.close(); }
  });

  it('reports exit 3 when the collector closes the connection unsolicited (--no-reconnect)', async () => {
    const h = await createCollectorHarness();
    try {
      const controller = new AbortController(); // never aborted: the close is the collector's
      const { done } = startCli(['tail', '--no-reconnect'], { harness: h, signal: controller.signal });
      // Give the socket a moment to connect and receive the snapshot, then drop it.
      await new Promise((r) => setTimeout(r, 80));
      await h.close(); // closes the ws server → unsolicited close on the client
      const r = await done;
      expect(r.code).toBe(3);
      expect(r.stderr).toContain('collector closed the connection');
    } finally { await h.close(); }
  });

  it('--json emits NDJSON with a snapshot and the injected entry', async () => {
    const h = await createCollectorHarness();
    try {
      const controller = new AbortController();
      const { done, out } = startCli(['tail', '--json'], { harness: h, signal: controller.signal });
      await waitUntil(() => out().includes('"type":"snapshot"'));
      h.store.addEntry(makeEntry({ id: 'live', url: 'https://api.example.com/x' }));
      await waitUntil(() => out().includes('"type":"entry"'));
      controller.abort();
      await done;

      const lines = out().trim().split('\n').filter(Boolean);
      const types = lines.map((l) => JSON.parse(l).type);
      expect(types).toContain('snapshot');
      expect(types).toContain('entry');
    } finally { await h.close(); }
  });
});
