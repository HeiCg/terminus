import { describe, it, expect } from 'vitest';
import { createCollectorHarness } from '../../collector/test/fixtures/harness.js';
import { runCli, makeEntry } from './helpers.js';

// Entries are paged oldest-first (sort key startedAt). With a tiny page size the
// single matching entry (the newest) sits on the last page, unreachable by the old
// single-page fetch but found once `ls` pages through the store.
describe('ls --limit with filters paginates', () => {
  it('returns the match that lives past the first page', async () => {
    const h = await createCollectorHarness();
    try {
      const base = Date.now();
      for (let i = 1; i <= 4; i++) h.store.addEntry(makeEntry({ id: `n${i}`, startedAt: base + i, status: 200, url: `https://api.example.com/n${i}` }));
      h.store.addEntry(makeEntry({ id: 'hit', startedAt: base + 9, status: 500, url: 'https://api.example.com/boom' }));

      const r = await runCli(['ls', '--status', '5xx', '--limit', '3'], { harness: h, env: { TERMINUS_LS_PAGE_SIZE: '2' } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('/boom');
      expect(r.stdout).not.toContain('/n1');
    } finally { await h.close(); }
  });

  it('warns on stderr when the page ceiling is hit before N matches', async () => {
    const h = await createCollectorHarness();
    try {
      const base = Date.now();
      for (let i = 1; i <= 4; i++) h.store.addEntry(makeEntry({ id: `n${i}`, startedAt: base + i, status: 200, url: `https://api.example.com/n${i}` }));
      h.store.addEntry(makeEntry({ id: 'hit', startedAt: base + 9, status: 500, url: 'https://api.example.com/boom' }));

      const r = await runCli(['ls', '--status', '5xx', '--limit', '3'], { harness: h, env: { TERMINUS_LS_PAGE_SIZE: '1', TERMINUS_LS_MAX_PAGES: '1' } });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('stopped after 1 pages');
      expect(r.stdout).toContain('no entries');
    } finally { await h.close(); }
  });

  it('without a client filter keeps the single-page behaviour', async () => {
    const h = await createCollectorHarness();
    try {
      h.store.addEntry(makeEntry());
      const r = await runCli(['ls', '--limit', '5'], { harness: h, env: { TERMINUS_LS_PAGE_SIZE: '2' } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('api.example.com/v1/items');
    } finally { await h.close(); }
  });
});
