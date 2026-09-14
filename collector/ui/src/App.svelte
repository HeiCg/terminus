<script lang="ts">
  import { useNav, useSession, useCache, useStore, useClock, useFilters, useSelection } from './lib/context.js';
  import { hotkeys } from './lib/attach/hotkeys.js';
  import { entityKey } from './lib/protocol.js';
  import type { Row } from './lib/state/Filters.svelte.js';
  import Sidebar from './components/Sidebar.svelte';
  import Topbar from './components/Topbar.svelte';
  import Banner from './components/Banner.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import ShortcutsSheet from './components/ShortcutsSheet.svelte';
  import EmptyState from './components/EmptyState.svelte';
  import Login from './views/Login.svelte';
  import CaptureView from './views/Capture/CaptureView.svelte';
  import SocketsView from './views/Sockets/SocketsView.svelte';
  import DevicesView from './views/Devices/DevicesView.svelte';

  // The runtime singletons are seeded into context at mount (main.ts / the test
  // harness); the shell just reads what it needs. Filters/Selection are now
  // app-lifetime (created in main.ts), so the command palette and j/k navigation
  // reach them on every view without any per-mount `register` handshake.
  const session = useSession();
  const nav = useNav();
  const cache = useCache();
  const store = useStore();
  const clock = useClock();
  const filters = useFilters();
  const selection = useSelection();

  // Settings lands in a later task; until then that tab shows a placeholder so the
  // switch is total and the shell renders.
  const placeholder = 'Settings — coming soon';

  let paletteOpen = $state(false);
  let shortcutsOpen = $state(false);

  function focusSearch(): void {
    document.querySelector<HTMLElement>('[data-testid="search"]')?.focus();
  }

  // Move the table selection by delta over the CURRENT filtered/sorted rows. No
  // wrap: it clamps at either end. Only meaningful on the Capture tab, and it asks
  // the table to scroll the newly-selected row into view (it may be unmounted).
  function moveSelection(delta: number): void {
    if (nav.view !== 'capture') return;
    const rows = filters.rows;
    if (rows.length === 0) return;
    const cur = selection.current;
    const at = cur
      ? rows.findIndex((r) => entityKey(r.deviceId, r.id) === entityKey(cur.deviceId, cur.id))
      : -1;
    const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + delta));
    const row = rows[next];
    void selection.select(row);
    selection.scrollToKey?.(entityKey(row.deviceId, row.id));
  }

  // Escape closes the palette when it is open; otherwise it clears the selection
  // (dismissing the detail panel) — the chosen "escape = step back" semantics.
  // The clear is scoped to Capture: on Sockets/Devices the Capture selection is
  // invisible, so Escape there must not silently wipe it. ⌘K opens the palette on
  // every view (no Capture gate).
  const keymap: Record<string, (e: KeyboardEvent) => void> = {
    'mod+k': () => { paletteOpen = !paletteOpen; },
    escape: () => {
      if (paletteOpen) paletteOpen = false;
      else if (nav.view === 'capture') void selection.select(null);
    },
    j: () => moveSelection(1),
    k: () => moveSelection(-1),
    '/': (e) => { e.preventDefault(); focusSearch(); },
    // `?` / mod+/ toggles the shortcuts sheet. The sheet owns its own Escape, so
    // this only ever opens (or re-toggles) it.
    help: (e) => { e.preventDefault(); shortcutsOpen = !shortcutsOpen; },
  };

  // Picking a palette result selects the row and jumps to Capture, wherever the
  // palette was opened from.
  function onpick(row: Row): void {
    void selection.select(row);
    nav.go('capture');
    paletteOpen = false;
  }
</script>

<div class="app" {@attach hotkeys(keymap)}>
  {#if session.status === 'login'}
    <Login />
  {:else}
    <div class="shell">
      <Sidebar />
      <div class="col" class:paused={session.paused}>
        <Topbar {filters} {session} {store} {clock} />
        {#if session.connection === 'reconnecting'}
          <Banner kind="warning">{@render reconnecting()}</Banner>
        {/if}
        <main class:dim={session.connection === 'reconnecting'}>
          {#if nav.view === 'capture'}
            <CaptureView />
          {:else if nav.view === 'sockets'}
            <SocketsView />
          {:else if nav.view === 'devices'}
            <DevicesView />
          {:else}
            <EmptyState title={placeholder} />
          {/if}
        </main>
      </div>
    </div>

    {#if paletteOpen}
      <CommandPalette
        open={paletteOpen}
        onclose={() => (paletteOpen = false)}
        {filters}
        {selection}
        {cache}
        {onpick}
        onshortcuts={() => { paletteOpen = false; shortcutsOpen = true; }}
      />
    {/if}

    {#if shortcutsOpen}
      <ShortcutsSheet onclose={() => (shortcutsOpen = false)} />
    {/if}
  {/if}
</div>

{#snippet reconnecting()}
  <span class="rc">
    <svg class="spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
    Reconectando ao collector… tentativa {session.reconnectAttempt}
  </span>
{/snippet}

<style>
  .app {
    height: 100%;
  }
  .shell {
    display: flex;
    height: 100%;
    background: var(--bg-base);
  }
  .col {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  main {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  /* Reconnecting: the content column dims while the socket re-establishes; the
     warning banner above stays live. Kept interactive (no pointer-events lock)
     so a paused/queued view can still be operated during a blip. */
  main.dim {
    opacity: 0.6;
  }
  /* Paused: the request table header carries a 2px amber top border. The rule
     reaches into RequestTable's scoped .thead via :global — App owns the shell
     state, RequestTable owns the header markup. */
  .col.paused :global(.thead) {
    border-top: 2px solid var(--status-4xx);
  }
  .rc {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
</style>
