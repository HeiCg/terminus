<script lang="ts">
  import type { Store } from '../lib/state/Store.svelte.js';
  import type { Session } from '../lib/state/Session.svelte.js';
  import type { Filters } from '../lib/state/Filters.svelte.js';
  import type { Clock } from '../lib/state/Clock.svelte.js';
  import { clear, exportUrl, setPaused } from '../lib/api.js';
  import { MAX_ENTRIES } from '../lib/limits.js';
  import { fmtBytes } from '../lib/format.js';
  import Button from './Button.svelte';
  import DeviceSwitcher from './DeviceSwitcher.svelte';

  // Presentational: the runtime singletons come in as props so the topbar is
  // unit-testable without a context provider. CaptureView wires them from context.
  type Props = { filters: Filters; session: Session; store: Store; clock: Clock };
  let { filters, session, store, clock }: Props = $props();

  let exportOpen = $state(false);
  let exportTrigger = $state<HTMLElement | null>(null);
  // setPaused THROWS on a rejected toggle; keep the prior UI state and surface a
  // one-line inline error rather than leaking an unhandled rejection.
  let pauseError = $state<string | null>(null);
  // clear() is fire-and-forget; catch any rejection so it never floats as an
  // unhandled rejection, warn, and surface the same one-line inline error.
  let clearError = $state<string | null>(null);

  const retention = $derived(
    `${store.entries.length} / ${MAX_ENTRIES} · ${fmtBytes(store.retention?.retainedBodyBytes)}`,
  );

  async function togglePause(): Promise<void> {
    const next = !session.paused;
    try {
      session.paused = await setPaused(next);
      pauseError = null;
    } catch {
      pauseError = 'Failed to pause';
    }
  }

  function runClear(): void {
    const scope = filters.device === 'all' ? undefined : filters.device;
    clearError = null;
    void clear(scope).catch((e: unknown) => {
      console.warn('Clear failed', e);
      clearError = 'Failed to clear';
    });
  }

  function doExport(kind: 'har' | 'json'): void {
    exportOpen = false;
    window.open(exportUrl(kind));
  }

  // Dismiss the open export menu on Escape or a pointerdown outside it. Attached
  // to the menu root only while it is open, so the document listeners live and
  // die with the menu — the sanctioned {@attach} lifecycle, not an effect.
  function dismissable(node: HTMLElement): () => void {
    const onPointer = (e: PointerEvent): void => {
      // Ignore pointerdowns on the trigger: pointerdown fires before its click,
      // so closing here would let the trigger's click immediately re-open it.
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (node.contains(t) || exportTrigger?.contains(t)) return;
      exportOpen = false;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') exportOpen = false;
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }
</script>

<header class="topbar">
  <span class="brand">Terminus</span>

  <DeviceSwitcher
    devices={store.devices}
    value={filters.device}
    onchange={(id) => (filters.device = id)}
    now={clock.now}
  />

  <input
    class="search"
    type="search"
    data-testid="search"
    placeholder="Search url, header, body…  ⌘K"
    aria-label="Search"
    bind:value={filters.search}
  />

  <div class="spacer"></div>

  {#if pauseError}<span class="err" style="--tint: var(--status-5xx)">{pauseError}</span>{/if}
  {#if clearError}<span class="err" style="--tint: var(--status-5xx)">{clearError}</span>{/if}
  {#if store.truncated}<span class="warn" style="--tint: var(--status-4xx)">window truncated</span>{/if}
  {#if store.atMax}<span class="warn" style="--tint: var(--status-4xx)">at limit</span>{/if}

  <span class="retention" title="Retained entries / max · retained body bytes">{retention}</span>

  {#if session.paused}
    <span class="paused-pill" data-testid="paused-pill" style="--tint: var(--status-4xx)">Paused</span>
  {/if}

  <Button variant="secondary" active={session.paused} onclick={togglePause}>
    {session.paused ? 'Resume' : 'Pause'}
  </Button>

  <Button variant="ghost" onclick={runClear}>
    Clear
  </Button>

  <div class="export">
    <!-- Wrapper carries the DOM ref: bind:this on <Button> yields the component
         instance, and dismissable needs the element for .contains(). -->
    <span class="trigger" bind:this={exportTrigger}>
      <Button variant="secondary" onclick={() => (exportOpen = !exportOpen)} aria-expanded={exportOpen}>
        Export ▾
      </Button>
    </span>
    {#if exportOpen}
      <!-- Items are plain buttons (implicit role button), NOT role="menuitem":
           the unmodifiable browser spec drives export via
           getByRole('button', { name: 'Export JSON' }), which a menuitem role
           would hide. Escape / outside-click dismissal comes from {@attach}. -->
      <div class="menu" {@attach dismissable}>
        <button type="button" aria-label="Export HAR" onclick={() => doExport('har')}>HAR</button>
        <button type="button" aria-label="Export JSON" onclick={() => doExport('json')}>JSON</button>
      </div>
    {/if}
  </div>
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: 10px;
    height: var(--topbar-h);
    flex: 0 0 var(--topbar-h);
    padding: 0 12px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border-subtle);
  }
  .brand {
    font-size: 13px;
    font-weight: 600;
    color: var(--fg-primary);
    white-space: nowrap;
  }
  .search {
    width: 480px;
    max-width: 40vw;
    height: 30px;
    padding: 0 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
  .search::placeholder {
    color: var(--fg-muted);
  }
  .spacer {
    flex: 1 1 auto;
  }
  .retention {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
    white-space: nowrap;
  }
  .warn,
  .err {
    font-size: 11px;
    color: var(--tint);
    background: var(--tint-surface);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }
  .paused-pill {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--tint);
    background: var(--tint-surface);
    padding: 2px 8px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .export {
    position: relative;
  }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    min-width: 96px;
    padding: 4px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }
  .menu button {
    padding: 6px 10px;
    text-align: left;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .menu button:hover {
    color: var(--fg-primary);
    background: var(--bg-surface);
  }
</style>
