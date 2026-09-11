<script lang="ts">
  import type { Sockets, SessionFilter } from '../../lib/state/Sockets.svelte.js';
  import type { WsSummary } from '../../lib/protocol.js';
  import { fmtTime } from '../../lib/format.js';
  import Chip from '../../components/Chip.svelte';
  import KindBadge from '../../components/KindBadge.svelte';
  import StatePill from '../../components/StatePill.svelte';
  import EmptyState from '../../components/EmptyState.svelte';

  type Props = { sockets: Sockets };
  let { sockets }: Props = $props();

  const FILTERS: { id: SessionFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'ws', label: 'WS' },
    { id: 'sse', label: 'SSE' },
    { id: 'open', label: 'Open' },
    { id: 'closed', label: 'Closed' },
  ];
</script>

<div class="sessionlist">
  <div class="filters" role="group" aria-label="Filter sessions">
    {#each FILTERS as f (f.id)}
      <Chip active={sockets.filter === f.id} onclick={() => (sockets.filter = f.id)}>{f.label}</Chip>
    {/each}
  </div>

  <div class="rows">
    {#if sockets.sessions.length === 0}
      <EmptyState title="No sessions" hint="WebSocket and SSE sessions appear here as the device opens connections." />
    {:else}
      {#each sockets.sessions as s (s.wsId)}
        {@render row(s)}
      {/each}
    {/if}
  </div>
</div>

{#snippet row(s: WsSummary)}
  <button
    type="button"
    class={['row', { selected: s.wsId === sockets.selectedId }]}
    data-testid={`ws-row-${s.wsId}`}
    aria-current={s.wsId === sockets.selectedId ? 'true' : undefined}
    onclick={() => sockets.select(s.wsId)}
  >
    <div class="line1">
      <KindBadge kind={s.kind === 'sse' ? 'sse' : 'ws'} />
      {#if s.url == null}
        <span class="url unknown" title="opened before the collector started">URL unknown (opened before the collector started)</span>
      {:else}
        <span class="url">{s.url}</span>
      {/if}
      {#if s.resumed}
        <span class="resumed" title="resumed: this socket was open before the collector started">resumed</span>
      {/if}
      <StatePill closedAt={s.closedAt} closeCode={s.closeCode} />
    </div>
    <div class="line2">
      <span class="frames">frames {s.retainedFrames} / {s.totalFrames}</span>
      {#if s.droppedFrames > 0}
        <span class="dot" aria-hidden="true">·</span>
        <span class="dropped" style="--tint: var(--status-5xx)">↓{s.droppedFrames}</span>
      {/if}
      {#if s.partial}
        <span class="dot" aria-hidden="true">·</span>
        <svg class="partial" width="12" height="12" viewBox="0 0 12 12" style="--tint: var(--status-4xx)" aria-label="partial capture">
          <title>partial capture</title>
          <path d="M6 1 11 10.5H1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
          <path d="M6 4.5v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          <circle cx="6" cy="9" r="0.6" fill="currentColor" />
        </svg>
      {/if}
      <span class="dot" aria-hidden="true">·</span>
      <span class="opened">opened {fmtTime(s.openedAt)}</span>
    </div>
  </button>
{/snippet}

<style>
  /* Fills the pane its host sizes: the 40% / min-width / right border live on the
     SocketsView wrapper, so the list itself just stretches to fill. */
  .sessionlist {
    flex: 1 1 auto;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-surface);
  }
  .filters {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 40px;
    flex: 0 0 40px;
    padding: 0 10px;
    overflow-x: auto;
    border-bottom: 1px solid var(--border-subtle);
  }
  .rows {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .row {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 3px;
    width: 100%;
    height: 56px;
    padding: 0 12px;
    text-align: left;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-subtle);
    cursor: pointer;
  }
  .row:hover {
    background: var(--bg-elevated);
  }
  .row.selected {
    background: var(--accent-soft);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .line1 {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .url {
    flex: 1 1 auto;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .url.unknown {
    font-style: italic;
    color: var(--fg-muted);
  }
  .resumed {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    height: 16px;
    padding: 0 6px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    line-height: 1;
    text-transform: uppercase;
    color: var(--status-4xx);
    background: var(--tint-surface);
    border-radius: 999px;
  }
  .line2 {
    display: flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dropped {
    color: var(--tint);
  }
  .partial {
    flex: 0 0 auto;
    color: var(--tint);
    vertical-align: middle;
  }
  .dot {
    color: var(--border-strong);
  }
</style>
