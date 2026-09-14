<script lang="ts">
  import type { Attachment } from 'svelte/attachments';
  import type { Filters, Row } from '../lib/state/Filters.svelte.js';
  import type { Selection } from '../lib/state/Selection.svelte.js';
  import type { BodyCache } from '../lib/bodyCache.js';
  import type { EntryDetail } from '../lib/protocol.js';
  import { entityKey } from '../lib/protocol.js';

  // The palette reads the SAME runtime objects CaptureView owns (lifted to App
  // via props). It searches `filters.allRows` — the device-scoped set with no
  // chip applied — so an active type/status/search filter never hides a match.
  type Props = {
    open: boolean;
    onclose: () => void;
    filters: Filters;
    selection: Selection;
    cache: BodyCache;
    onpick: (row: Row) => void;
    // Optional "Actions" entry: opens the keyboard-shortcuts sheet. Absent (as in
    // the component's own tests) → no Actions group renders at all.
    onshortcuts?: () => void;
  };
  let { open, onclose, filters, selection, cache, onpick, onshortcuts }: Props = $props();

  const CAP = 50;
  const MIN_BODY_QUERY = 2; // below this, the (unbounded) body scan is skipped
  const DEBOUNCE_MS = 120;

  // `raw` mirrors the input for display; `query` is the debounced value the
  // deriveds search, so a burst of keystrokes recomputes the scan once.
  let raw = $state('');
  let query = $state('');
  let active = $state(0);
  let debounce: ReturnType<typeof setTimeout> | null = null;

  // The element focused when the palette opened, captured at init (before the
  // input's focus attachment runs) so close/pick can hand focus back.
  const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

  const q = $derived(query.trim().toLowerCase());
  const rows = $derived(filters.allRows);

  const statusText = (r: Row): string => `${r.status ?? ''} ${r.error ?? ''}`.toLowerCase();

  function headerHit(detail: EntryDetail | undefined, needle: string): boolean {
    if (!detail) return false;
    for (const v of Object.values(detail.requestHeaders)) if (v.toLowerCase().includes(needle)) return true;
    for (const v of Object.values(detail.responseHeaders)) if (v.toLowerCase().includes(needle)) return true;
    return false;
  }

  // Requests group: url / method / status / cached-header matches. `rows`
  // (filters.allRows) is newest-first, so an empty query lists the 50 MOST RECENT
  // rows — ⌘K with no typing is a recent-traffic jump list — and the 50-item cap
  // on a query keeps the newest matches too.
  const requestMatches = $derived.by((): Row[] => {
    if (!q) return rows.slice(0, CAP);
    const out: Row[] = [];
    for (const r of rows) {
      const detail = selection.detailsCache.get(entityKey(r.deviceId, r.id));
      if (r.url.toLowerCase().includes(q) || r.method.toLowerCase().includes(q) || statusText(r).includes(q) || headerHit(detail, q)) {
        out.push(r);
        if (out.length >= CAP) break;
      }
    }
    return out;
  });

  // Bodies group: rows whose RESPONSE body is resident AND whose (lowercased,
  // memoized) text contains the query. Skipped under MIN_BODY_QUERY so a single
  // keystroke never scans every resident body. peekLower() is non-touching — a
  // $derived must not reorder the cache LRU — and returns undefined for a body
  // whose lowercased copy is too large to cache; such a row simply drops out of
  // the body scan (it can still match via url/method/status/headers above).
  const bodyMatches = $derived.by((): Row[] => {
    if (q.length < MIN_BODY_QUERY) return [];
    const out: Row[] = [];
    for (const r of rows) {
      const hash = r.responseBody.sha256;
      if (!hash) continue;
      const text = cache.peekLower(hash);
      if (text && text.includes(q)) {
        out.push(r);
        if (out.length >= CAP) break;
      }
    }
    return out;
  });

  // Actions group (only when the host wires `onshortcuts`): a single "Keyboard
  // shortcuts" command, shown for an empty query or one that prefixes its keywords
  // so it never clutters an unrelated search. Sits first in the flat order.
  type FlatItem = { group: 'act'; label: string; run: () => void } | { group: 'req' | 'bod'; row: Row };
  const actionItems = $derived.by((): FlatItem[] => {
    if (!onshortcuts) return [];
    const show = q === '' || 'keyboard shortcuts help'.includes(q);
    return show ? [{ group: 'act', label: 'Keyboard shortcuts', run: onshortcuts }] : [];
  });

  // One flat, capped navigation order over every group, then split back so every
  // RENDERED option is within the navigable cap (and so one carries the active
  // marker). act precedes req precedes bod, so the flat indices line up below.
  const flat = $derived.by((): FlatItem[] =>
    [
      ...actionItems,
      ...requestMatches.map((row): FlatItem => ({ group: 'req', row })),
      ...bodyMatches.map((row): FlatItem => ({ group: 'bod', row })),
    ].slice(0, CAP),
  );
  const actShown = $derived(flat.filter((f): f is Extract<FlatItem, { group: 'act' }> => f.group === 'act'));
  const reqShown = $derived(flat.filter((f) => f.group === 'req').map((f) => (f as Extract<FlatItem, { group: 'req' | 'bod' }>).row));
  const bodShown = $derived(flat.filter((f) => f.group === 'bod').map((f) => (f as Extract<FlatItem, { group: 'req' | 'bod' }>).row));
  // Where each group starts in the flat index space, so option ids/active markers
  // stay correct once the Actions group shifts requests/bodies down.
  const reqBase = $derived(actShown.length);
  const bodBase = $derived(actShown.length + reqShown.length);

  const activeIndex = $derived(flat.length === 0 ? 0 : Math.min(active, flat.length - 1));
  const optionId = (i: number): string => `cmdp-opt-${i}`;

  function move(delta: number): void {
    if (flat.length === 0) return;
    active = Math.min(flat.length - 1, Math.max(0, activeIndex + delta));
  }

  function pick(row: Row | undefined): void {
    if (!row) return;
    onpick(row);
    onclose();
  }

  // Enter/click on the active flat item: run an action, or pick a request row.
  function activate(item: FlatItem | undefined): void {
    if (!item) return;
    if (item.group === 'act') { item.run(); onclose(); return; }
    pick(item.row);
  }

  function onInput(e: Event): void {
    raw = (e.currentTarget as HTMLInputElement).value;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { query = raw; active = 0; }, DEBOUNCE_MS);
  }

  // Apply any pending debounced query NOW so `flat` reflects what the user has
  // typed — used on Enter so a fast ↵ never picks the previous query's result.
  function flushQuery(): void {
    if (debounce) { clearTimeout(debounce); debounce = null; }
    if (query !== raw) { query = raw; active = 0; }
  }

  function onKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      // Flush first: reading `flat` after the state change recomputes it against
      // the current query, so ↵ picks from what is actually typed.
      case 'Enter': e.preventDefault(); flushQuery(); activate(flat[activeIndex]); break;
      // Stop here so the App-root escape handler never also runs (which would
      // clear the table selection); the palette owns Escape while it is open.
      case 'Escape': e.preventDefault(); e.stopPropagation(); onclose(); break;
      case 'Tab': e.preventDefault(); break; // trap focus on the single input
      default: break;
    }
  }

  const focusInput: Attachment = (node) => { (node as HTMLInputElement).focus(); };

  // Reset the query every time the palette (re)opens. `{#if open}` re-creates the
  // panel on each open, so this mount-time attachment clears a query left over
  // from a previous ⌘K — reopening always starts blank, never on stale results.
  const resetOnOpen: Attachment = () => {
    raw = '';
    query = '';
    active = 0;
    if (debounce) { clearTimeout(debounce); debounce = null; }
  };

  // On teardown (close/pick): cancel any pending debounce timer and restore focus
  // to the opener, falling back to the search box. Bound on the root so it runs
  // when the palette unmounts.
  const restoreFocus: Attachment = () => () => {
    if (debounce) { clearTimeout(debounce); debounce = null; }
    const back = opener && opener !== document.body && document.contains(opener)
      ? opener
      : document.querySelector<HTMLElement>('[data-testid="search"]');
    back?.focus();
  };
</script>

{#if open}
  <div class="backdrop" role="presentation" onpointerdown={onclose} {@attach restoreFocus}>
    <div class="panel" role="dialog" tabindex="-1" aria-modal="true" aria-label="Command palette" onpointerdown={(e) => e.stopPropagation()} {@attach resetOnOpen}>
      <input
        class="input"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="cmdp-list"
        aria-activedescendant={flat.length > 0 ? optionId(activeIndex) : undefined}
        aria-label="Search commands"
        placeholder="Search url, method, status, body…"
        value={raw}
        oninput={onInput}
        onkeydown={onKeydown}
        {@attach focusInput}
      />

      {#if flat.length === 0}
        <p class="empty">No matches</p>
      {/if}
      <div class="list" id="cmdp-list" role="listbox" aria-label="Results">
        {#if flat.length > 0}
          {#if actShown.length > 0}
            <div class="grp" role="group" aria-label="Actions">
              <div class="group" aria-hidden="true">Actions</div>
              {#each actShown as act, a (act.label)}
                <button
                  type="button"
                  class="option"
                  class:active={activeIndex === a}
                  id={optionId(a)}
                  role="option"
                  aria-selected={activeIndex === a}
                  onclick={() => { act.run(); onclose(); }}
                >
                  <span class="url">{act.label}</span>
                  <span class="status">?</span>
                </button>
              {/each}
            </div>
          {/if}
          {#if reqShown.length > 0}
            <div class="grp" role="group" aria-label="Requests">
              <div class="group" aria-hidden="true">Requests</div>
              {#each reqShown as row, i (entityKey(row.deviceId, row.id))}
                {@const idx = reqBase + i}
                <button
                  type="button"
                  class="option"
                  class:active={activeIndex === idx}
                  id={optionId(idx)}
                  role="option"
                  aria-selected={activeIndex === idx}
                  onclick={() => pick(row)}
                >
                  <span class="method">{row.method}</span>
                  <span class="url">{row.host}{row.path}</span>
                  <span class="status">{row.status ?? '—'}</span>
                </button>
              {/each}
            </div>
          {/if}
          {#if bodShown.length > 0}
            <div class="grp" role="group" aria-label="Bodies (loaded only)">
              <div class="group" aria-hidden="true">Bodies (loaded only)</div>
              {#each bodShown as row, j (entityKey(row.deviceId, row.id))}
                {@const idx = bodBase + j}
                <button
                  type="button"
                  class="option"
                  class:active={activeIndex === idx}
                  id={optionId(idx)}
                  role="option"
                  aria-selected={activeIndex === idx}
                  onclick={() => pick(row)}
                >
                  <span class="method">{row.method}</span>
                  <span class="url">{row.host}{row.path}</span>
                  <span class="status">{row.status ?? '—'}</span>
                </button>
              {/each}
            </div>
          {/if}
        {/if}
      </div>

      <div class="footer">↑↓ navigate · ↵ open · esc close</div>
    </div>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 100; display: flex; justify-content: center; align-items: flex-start; padding-top: 15vh; background: color-mix(in srgb, var(--bg-base) 60%, transparent); }
  .panel { width: 560px; max-width: 92vw; display: flex; flex-direction: column; max-height: 60vh; background: var(--bg-elevated); border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden; }
  .input { height: 44px; padding: 0 14px; font-family: var(--font-mono); font-size: 13px; color: var(--fg-primary); background: transparent; border: none; border-bottom: 1px solid var(--border-subtle); }
  .input:focus { outline: none; }
  .input::placeholder { color: var(--fg-muted); }
  .list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px; }
  .group { padding: 8px 10px 4px; font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-muted); }
  .empty { margin: 0; padding: 20px; text-align: center; font-size: 12px; color: var(--fg-muted); }
  .option { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 10px; text-align: left; background: transparent; border: none; border-radius: var(--radius-sm); cursor: pointer; }
  .option.active, .option:hover { background: var(--bg-surface); }
  .method { flex: 0 0 auto; font-family: var(--font-mono); font-size: 11px; color: var(--fg-secondary); }
  .url { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 12px; color: var(--fg-primary); }
  .status { flex: 0 0 auto; font-family: var(--font-mono); font-size: 11px; color: var(--fg-muted); }
  .footer { flex: 0 0 auto; padding: 8px 12px; font-size: 11px; color: var(--fg-muted); border-top: 1px solid var(--border-subtle); }
</style>
