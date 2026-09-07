<script lang="ts">
  import type { Attachment } from 'svelte/attachments';
  import type { Row } from '../../lib/state/Filters.svelte.js';
  import { fmtBytes, fmtMs, fmtTime, durationBucket } from '../../lib/format.js';
  import StatusPill from '../../components/StatusPill.svelte';
  import MethodTag from '../../components/MethodTag.svelte';
  import KindBadge from '../../components/KindBadge.svelte';
  import SourceDot from '../../components/SourceDot.svelte';

  type Props = { row: Row; selected: boolean; onselect: (row: Row) => void };
  let { row, selected, onselect }: Props = $props();

  // Bring the row into view when it BECOMES selected — keyboard j/k selection can
  // land on a row scrolled out of the viewport. `block: 'nearest'` is a no-op when
  // it is already visible, so a click-select never jolts the list. The attachment
  // re-runs only on the false→true transition (the expression changes identity),
  // not on every re-render while it stays selected.
  // Optional-chained: jsdom leaves scrollIntoView undefined (like scrollTo), so
  // the component tests never trip on it.
  const scrollIntoView: Attachment = (node) => { node.scrollIntoView?.({ block: 'nearest' }); };

  const barPct = $derived(row.durationMs == null ? 0 : Math.min(100, (row.durationMs / 2000) * 100));
  const durTint = $derived(
    durationBucket(row.durationMs) === 'fast'
      ? 'status-2xx'
      : durationBucket(row.durationMs) === 'mid'
        ? 'status-4xx'
        : durationBucket(row.durationMs) === 'slow'
          ? 'status-5xx'
          : null,
  );
</script>

<button
  type="button"
  class="row"
  class:selected
  data-testid={`entry-row-${row.id}`}
  aria-pressed={selected}
  aria-label={`${row.method} ${row.url}`}
  onclick={() => onselect(row)}
  {@attach selected ? scrollIntoView : undefined}
>
  <span class="c status"><StatusPill status={row.status} error={row.error} /></span>
  <span class="c method"><MethodTag method={row.method} /></span>
  <span class="c host" title={row.host}>{row.host}</span>
  <span class="c path">
    <span class="badge-slot">{#if row.kind !== 'xhr'}<KindBadge kind={row.kind} />{/if}</span>
    <span class="path-text" title={row.path}>{row.path}</span>
  </span>
  <span class="c src"><SourceDot source={row.source} /></span>
  <span class="c size">{fmtBytes(row.size)}</span>
  <span class="c dur">
    <span class="dur-text">{fmtMs(row.durationMs)}</span>
    {#if durTint}
      <span class="dur-track" aria-hidden="true">
        <span class="dur-fill" style={`width:${barPct}%;--tint:var(--${durTint})`}></span>
      </span>
    {/if}
  </span>
  <span class="c time">{fmtTime(row.startedAt)}</span>
</button>

<style>
  .row {
    display: grid;
    grid-template-columns: var(--cols);
    align-items: center;
    width: 100%;
    height: var(--row-h);
    padding: 0;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--fg-primary);
  }
  .row:hover {
    background: var(--bg-elevated);
  }
  /* Inset shadow, not a border, so the 2px accent bar never shifts the grid
     tracks out of alignment with the header. */
  .row.selected {
    background: var(--accent-soft);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .c {
    display: flex;
    align-items: center;
    min-width: 0;
    padding: 0 8px;
    font-size: 12px;
  }
  .host {
    font-family: var(--font-mono);
    color: var(--fg-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
    line-height: var(--row-h);
  }
  .path {
    gap: 4px;
  }
  .badge-slot {
    flex: 0 0 40px;
    display: flex;
    align-items: center;
  }
  .path-text {
    flex: 1 1 auto;
    min-width: 0;
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .size {
    justify-content: flex-end;
    font-family: var(--font-mono);
    color: var(--fg-secondary);
  }
  .dur {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
  .dur-text {
    font-family: var(--font-mono);
    color: var(--fg-secondary);
    line-height: 1;
  }
  .dur-track {
    width: 100%;
    height: 3px;
    border-radius: 999px;
    background: var(--bg-elevated);
    overflow: hidden;
  }
  .dur-fill {
    display: block;
    height: 100%;
    background: var(--tint);
  }
  .time {
    font-family: var(--font-mono);
    color: var(--fg-muted);
  }
</style>
