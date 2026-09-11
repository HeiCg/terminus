<script lang="ts">
  import { useStore, useNav, useFilters, useSelection } from '../../lib/context.js';
  import { type Row } from '../../lib/state/Filters.svelte.js';
  import { entityKey } from '../../lib/protocol.js';
  import EmptyState from '../../components/EmptyState.svelte';
  import Button from '../../components/Button.svelte';
  import FilterBar from './FilterBar.svelte';
  import RequestTable from './RequestTable.svelte';
  import DetailPanel from './DetailPanel.svelte';

  const store = useStore();
  const nav = useNav();
  // App-lifetime singletons (created in main.ts, seeded into context): reading
  // them here means a tab switch preserves chips, search, sort, selection and the
  // detail cache. The Topbar now lives in the App shell, above every view.
  const filters = useFilters();
  const selection = useSelection();

  // The selected row's composite key drives the table row highlight.
  const selectedKey = $derived(
    selection.current ? entityKey(selection.current.deviceId, selection.current.id) : null,
  );

  // `version` is the Store's monotone arrival count (never saturates at the
  // retention cap the way `entries.length` would), independent of filtering.
  // `resetKey` is the active chip/sort/device signature; when it changes the table
  // re-mounts its scroller (BY DESIGN resetting scroll position to the arrival
  // edge) and the "N new" pill resets. `filters.search` is DELIBERATELY excluded:
  // typing in the search box must not re-mount the scroller and jump the scroll.
  const resetKey = $derived(
    JSON.stringify([
      filters.sort.key, filters.sort.dir, filters.device, filters.type,
      [...filters.statuses].sort(), [...filters.sources].sort(), filters.host, filters.hasBody,
    ]),
  );
</script>

<div class="capture">
  <FilterBar {filters} />
  <div class="content">
    <div class="list">
      {#if filters.device !== 'all' && filters.otherDeviceNew > 0}
        <!-- Live traffic is landing under a device other than the selected one —
             the trial's "looks frozen" case. Surfacing the count (and a one-click
             escape to All devices, which scrolls the table back to the newest
             edge via the resetKey remount) keeps the view from reading as dead. -->
        <button type="button" class="other-pill" data-testid="other-device-pill" onclick={() => (filters.device = 'all')}>
          {filters.otherDeviceNew} new on other devices · Show all
        </button>
      {/if}
      {#if store.entries.length === 0}
        <EmptyState
          title="Aguardando device…"
          hint="Pareie um device em Devices ou inicie o app em modo QA."
          action={waiting}
        />
      {:else if filters.device !== 'all' && filters.counts.all === 0}
        <EmptyState
          title="No requests on this device yet."
          hint="Traffic from this phone may be arriving under another device id — switch to All devices."
          action={switchToAll}
        />
      {:else}
        <RequestTable
          rows={filters.rows}
          {selectedKey}
          onselect={(row: Row) => selection.select(row)}
          sort={filters.sort}
          onsort={(k) => filters.setSort(k)}
          version={store.arrivals}
          {resetKey}
          registerScrollTo={(fn) => (selection.scrollToKey = fn)}
        />
      {/if}
    </div>
    {#if selection.current}
      <DetailPanel {selection} />
    {/if}
  </div>
</div>

{#snippet waiting()}
  <Button variant="secondary" onclick={() => nav.go('devices')}>Ir para Devices</Button>
{/snippet}

{#snippet switchToAll()}
  <Button variant="secondary" onclick={() => (filters.device = 'all')}>All devices</Button>
{/snippet}

<style>
  .capture {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .content {
    flex: 1 1 auto;
    display: flex;
    min-height: 0;
  }
  .list {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
  }
  .other-pill {
    position: absolute;
    left: 50%;
    top: 40px;
    transform: translateX(-50%);
    z-index: 6;
    padding: 4px 12px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-on-accent);
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 999px;
    cursor: pointer;
    white-space: nowrap;
  }
</style>
