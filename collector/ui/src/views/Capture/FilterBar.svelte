<script lang="ts">
  import type { Filters } from '../../lib/state/Filters.svelte.js';
  import Chip from '../../components/Chip.svelte';
  import Button from '../../components/Button.svelte';
  import SourceDot from '../../components/SourceDot.svelte';

  type Props = { filters: Filters };
  let { filters }: Props = $props();

  const STATUSES = ['2xx', '3xx', '4xx', '5xx'] as const;
  const SOURCES = [
    { source: 'xhr', label: 'xhr', tint: 'source-xhr' },
    { source: 'atlantis', label: 'atl', tint: 'source-atlantis' },
    { source: 'proxy', label: 'prx', tint: 'source-proxy' },
  ] as const;
</script>

<div class="filterbar">
  <div class="group">
    <Chip active={filters.type === 'all'} count={filters.counts.all} onclick={() => (filters.type = 'all')}>All</Chip>
    <Chip active={filters.type === 'xhr'} onclick={() => (filters.type = 'xhr')}>XHR</Chip>
    <Chip active={filters.type === 'ws'} onclick={() => (filters.type = 'ws')}>WS</Chip>
    <Chip active={filters.type === 'sse'} onclick={() => (filters.type = 'sse')}>SSE</Chip>
    <Chip active={filters.type === 'errors'} onclick={() => (filters.type = 'errors')}>Errors</Chip>
  </div>

  <span class="sep" aria-hidden="true"></span>

  <div class="group">
    {#each STATUSES as b (b)}
      <Chip active={filters.statuses.has(b)} tint={`status-${b}`} onclick={() => filters.toggleStatus(b)}>{b}</Chip>
    {/each}
  </div>

  <span class="sep" aria-hidden="true"></span>

  <div class="group">
    {#each SOURCES as s (s.source)}
      <Chip active={filters.sources.has(s.source)} tint={s.tint} onclick={() => filters.toggleSource(s.source)}>
        <span class="src-chip"><SourceDot source={s.source} />{s.label}</span>
      </Chip>
    {/each}
  </div>

  <span class="sep" aria-hidden="true"></span>

  <select
    class="host"
    aria-label="Filter by host"
    value={filters.host ?? ''}
    onchange={(e) => (filters.host = (e.currentTarget as HTMLSelectElement).value || null)}
  >
    <option value="">All hosts</option>
    {#each filters.hosts as h (h)}
      <option value={h}>{h}</option>
    {/each}
  </select>

  <Chip active={filters.hasBody} onclick={() => (filters.hasBody = !filters.hasBody)}>Has body</Chip>

  <div class="spacer"></div>

  <Button variant="ghost" size="sm" onclick={() => filters.clear()}>Clear filters</Button>
</div>

<style>
  .filterbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--filter-h);
    flex: 0 0 var(--filter-h);
    padding: 0 12px;
    background: var(--bg-base);
    border-bottom: 1px solid var(--border-subtle);
    overflow-x: auto;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sep {
    width: 1px;
    height: 18px;
    flex: 0 0 1px;
    background: var(--border-subtle);
  }
  .src-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .host {
    width: 120px;
    height: 28px;
    padding: 0 8px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
  .spacer {
    flex: 1 1 auto;
  }
</style>
