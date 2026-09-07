<script lang="ts">
  import { useNav, useSession } from '../lib/context.js';
  import type { View } from '../lib/state/Nav.svelte.js';

  const nav = useNav();
  const session = useSession();

  // Icon paths are inline SVG (never imported .svg — vite would file those under
  // dist-ui/fonts/). Stroke-based, drawn in currentColor so the active/inactive
  // colour comes straight from the button's text colour.
  const items: { view: View; label: string; path: string }[] = [
    { view: 'capture', label: 'Capture', path: 'M3 12h3l2 6 4-13 2 9h5' },
    { view: 'sockets', label: 'Sockets', path: 'M9 3v6M15 3v6M6 9h12v2a6 6 0 0 1-12 0zM12 17v4' },
    { view: 'devices', label: 'Devices', path: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2' },
    { view: 'settings', label: 'Settings', path: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2M6 6l1.5 1.5M16.5 16.5L18 18M18 6l-1.5 1.5M7.5 16.5L6 18' },
  ];

  const connText = $derived(
    session.status === 'boot' || session.status === 'authenticating'
      ? 'Autenticando…'
      : session.connection === 'open'
        ? 'Conectado'
        : session.connection === 'reconnecting'
          ? 'Reconectando…'
          : session.connection === 'connecting'
            ? 'Conectando…'
            : 'Desconectado',
  );
  const dotState = $derived(
    session.connection === 'open'
      ? 'on'
      : session.connection === 'reconnecting' || session.connection === 'connecting'
        ? 'wait'
        : 'off',
  );
</script>

<nav class="sidebar" aria-label="Navigation">
  <div class="rail">
    {#each items as item (item.view)}
      <button
        class="icon"
        class:active={nav.view === item.view}
        type="button"
        aria-label={item.label}
        aria-current={nav.view === item.view ? 'page' : undefined}
        title={item.label}
        onclick={() => nav.go(item.view)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d={item.path} />
        </svg>
      </button>
    {/each}
  </div>

  <div class="bottom">
    <div class="conn" title={connText}>
      <span class="dot {dotState}" aria-hidden="true"></span>
      <span class="conn-text" data-testid="capture-connection">{connText}</span>
    </div>

    <button class="icon" type="button" aria-label="Sair" title="Sair" onclick={() => session.logout()}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 17l-5-5 5-5M5 12h11" />
      </svg>
    </button>
  </div>
</nav>

<style>
  .sidebar {
    width: var(--sidebar-w);
    flex: 0 0 var(--sidebar-w);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 12px 0;
    background: var(--bg-surface);
    border-right: 1px solid var(--border-subtle);
  }
  .rail {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .icon {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    padding: 0;
    color: var(--fg-muted);
    background: transparent;
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
  }
  .icon:hover {
    color: var(--fg-secondary);
  }
  .icon.active {
    color: var(--fg-primary);
    background: var(--accent-soft);
  }
  .bottom {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .conn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--status-pending);
  }
  .dot.on { background: var(--status-2xx); }
  .dot.wait { background: var(--status-4xx); }
  .dot.off { background: var(--status-5xx); }
  /* The label is the connection state; kept off-screen so the 56px rail stays
     clean while the state is still exposed (and test-visible) via the testid. */
  .conn-text {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
