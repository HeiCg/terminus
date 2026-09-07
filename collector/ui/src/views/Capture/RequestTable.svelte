<script lang="ts">
  import type { Row, SortKey } from '../../lib/state/Filters.svelte.js';
  import { entityKey } from '../../lib/protocol.js';
  import { virtualList, type Range } from '../../lib/attach/virtualList.js';
  import { autoscroll } from '../../lib/attach/autoscroll.js';
  import TableHeaderCell from '../../components/TableHeaderCell.svelte';
  import RequestRow from './RequestRow.svelte';

  type Props = {
    rows: Row[];
    selectedKey: string | null;
    onselect: (row: Row) => void;
    sort: { key: SortKey; dir: 'asc' | 'desc' };
    onsort: (key: SortKey) => void;
    // Arrival counter (the Store's entry count) — filtering must NOT bump it. And
    // a signature of the active filters/sort: when it changes the scroller is
    // re-mounted so the pill/backlog reset (item 2's chosen reset mechanism).
    version?: number;
    resetKey?: string;
    // Hands the App-level j/k handler a `scrollToKey(key)` it can call after a
    // programmatic select; null on teardown. Registered from the table's {@attach}.
    registerScrollTo?: (fn: ((key: string) => void) | null) => void;
  };
  let { rows, selectedKey, onselect, sort, onsort, version = 0, resetKey = '', registerScrollTo }: Props = $props();

  const ROW_HEIGHT = 32;
  const OVERSCAN = 8;

  // Where the newest rows land under the current sort. Only a time sort has a
  // meaningful arrival edge; any other sort disables the pill entirely.
  const edge = $derived<'top' | 'bottom' | null>(
    sort.key === 'time' ? (sort.dir === 'desc' ? 'top' : 'bottom') : null,
  );

  // Sortable columns carry a SortKey; Src is decorative (no sort). Grid tracks in
  // `--cols` (set on the scroller) drive the widths for both header and rows.
  const COLS: { key: SortKey | null; label: string; align: 'left' | 'right' }[] = [
    { key: 'status', label: 'Status', align: 'left' },
    { key: 'method', label: 'Method', align: 'left' },
    { key: 'host', label: 'Host', align: 'left' },
    { key: 'path', label: 'Path', align: 'left' },
    { key: null, label: 'Src', align: 'left' },
    { key: 'size', label: 'Size', align: 'right' },
    { key: 'duration', label: 'Duration', align: 'left' },
    { key: 'time', label: 'Time', align: 'left' },
  ];

  // These live OUTSIDE the {#key resetKey} block on purpose: they are component
  // state, not element state, so re-mounting the scroller (on a filter/sort
  // change) must not discard them. autoscroll's first-mount onAttached resets the
  // pill; the windowing attachment recomputes `range` against the fresh element.
  let range = $state<Range>({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  let pendingNew = $state(0);
  let scroller = $state<HTMLElement | null>(null);

  const visible = $derived(rows.slice(range.start, range.end));

  function scrollToEdge(): void {
    pendingNew = 0;
    scroller?.scrollTo({ top: edge === 'bottom' ? scroller.scrollHeight : 0 });
  }

  // Scroll the row for `key` into view with `block: 'nearest'` semantics: the row
  // may be unmounted under virtualization, so its position is computed as
  // index * ROW_HEIGHT against the scroller rather than read from a DOM node.
  function scrollToKey(key: string): void {
    const el = scroller;
    if (!el) return;
    const idx = rows.findIndex((r) => entityKey(r.deviceId, r.id) === key);
    if (idx < 0) return;
    const top = idx * ROW_HEIGHT;
    const viewH = el.clientHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + viewH) el.scrollTop = top + ROW_HEIGHT - viewH;
  }

  // Register the scroll hook for the App handler's lifetime as a mount attachment
  // on the stable table root (not the re-mounting scroller): set on mount, null on
  // teardown. The {@attach} lifecycle owns the registration — no reactive effect.
  function registerApi(): () => void {
    registerScrollTo?.(scrollToKey);
    return () => registerScrollTo?.(null);
  }
</script>

<div class="table" style="--cols:64px 72px 200px minmax(0,1fr) 40px 72px 120px 88px" {@attach registerApi}>
  <div class="thead">
    {#each COLS as col (col.label)}
      <TableHeaderCell
        label={col.label}
        align={col.align}
        sort={col.key && sort.key === col.key ? sort.dir : null}
        onsort={col.key ? () => onsort(col.key as SortKey) : undefined}
      />
    {/each}
  </div>

  <!-- Keyed on the filter/sort signature: a filter or sort change re-mounts the
       scroller, so autoscroll re-mounts and clears the pill (arrivals, which only
       bump `version`, never change the key and so never re-mount it). BY DESIGN
       this also resets scroll position to the arrival edge on every filter/search
       change — a fresh query starts at the newest results. -->
  {#key resetKey}
    <div
      class="scroll"
      data-testid="request-scroll"
      bind:this={scroller}
      {@attach virtualList({ rowHeight: ROW_HEIGHT, overscan: OVERSCAN, count: rows.length, onRange: (r) => (range = r) })}
      {@attach edge ? autoscroll({ edge, version, onDetached: (n) => (pendingNew = n), onAttached: () => (pendingNew = 0) }) : false}
    >
      {#if rows.length === 0}
        <p class="no-results">No requests match the filters.</p>
      {:else}
        <div class="pad" style={`height:${range.padTop}px`}></div>
        {#each visible as row (entityKey(row.deviceId, row.id))}
          <RequestRow {row} selected={selectedKey === entityKey(row.deviceId, row.id)} {onselect} />
        {/each}
        <div class="pad" style={`height:${range.padBottom}px`}></div>
      {/if}
    </div>
  {/key}

  {#if edge && pendingNew > 0}
    <button type="button" class="new-pill" class:top={edge === 'top'} onclick={scrollToEdge}>
      {edge === 'top' ? '↑' : '↓'} {pendingNew} new
    </button>
  {/if}
</div>

<style>
  .table {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .thead {
    display: grid;
    grid-template-columns: var(--cols);
    align-items: center;
    height: 32px;
    flex: 0 0 32px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border-subtle);
  }
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .no-results {
    margin: 0;
    padding: 24px;
    text-align: center;
    font-size: 12px;
    color: var(--fg-muted);
  }
  .new-pill {
    position: absolute;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    z-index: 5;
    padding: 4px 12px;
    font-size: 12px;
    color: var(--fg-on-accent);
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 999px;
    cursor: pointer;
  }
  .new-pill.top {
    bottom: auto;
    top: 40px;
  }
</style>
