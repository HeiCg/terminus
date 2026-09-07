<script lang="ts">
  type Props = {
    label: string;
    width?: string;
    align?: 'left' | 'right';
    sort: 'asc' | 'desc' | null;
    onsort?: () => void;
  };
  let { label, width, align = 'left', sort, onsort }: Props = $props();

  const arrow = $derived(sort === 'asc' ? '▲' : sort === 'desc' ? '▼' : '');
  // aria-label carries the sort direction to assistive tech (the arrow glyph is
  // aria-hidden decoration). Chosen over aria-sort because the autofixer rejects
  // aria-sort on the implicit `button` role; label needs no columnheader wrapper.
  const ariaLabel = $derived(
    sort === 'asc'
      ? `${label}, sorted ascending`
      : sort === 'desc'
        ? `${label}, sorted descending`
        : undefined,
  );
</script>

{#if onsort}
  <button
    type="button"
    class={['thc', `a-${align}`, 'sortable']}
    style={width ? `width:${width}` : undefined}
    aria-label={ariaLabel}
    onclick={onsort}
  >
    <span class="lbl">{label}</span>
    {#if arrow}<span class="arrow" aria-hidden="true">{arrow}</span>{/if}
  </button>
{:else}
  <span class={['thc', `a-${align}`]} style={width ? `width:${width}` : undefined}>
    <span class="lbl">{label}</span>
    {#if arrow}<span class="arrow" aria-hidden="true">{arrow}</span>{/if}
  </span>
{/if}

<style>
  .thc {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    box-sizing: border-box;
    padding: 0 8px;
    font-family: var(--font-ui);
    font-size: 11px;
    letter-spacing: 0.04em;
    line-height: 1;
    text-transform: uppercase;
    color: var(--fg-secondary);
    background: transparent;
    border: none;
  }
  .a-right {
    justify-content: flex-end;
    text-align: right;
  }
  .sortable {
    cursor: pointer;
  }
  .sortable:hover {
    color: var(--fg-primary);
  }
  .arrow {
    font-size: 9px;
    color: var(--accent);
  }
</style>
