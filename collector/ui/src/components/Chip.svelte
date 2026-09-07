<script lang="ts">
  import type { Snippet } from 'svelte';

  type Tint =
    | 'status-2xx'
    | 'status-3xx'
    | 'status-4xx'
    | 'status-5xx'
    | 'source-xhr'
    | 'source-atlantis'
    | 'source-proxy';

  type Props = {
    active?: boolean;
    count?: number;
    tint?: Tint | null;
    onclick: () => void;
    children: Snippet;
  };

  let { active = false, count, tint = null, onclick, children }: Props = $props();
</script>

<button
  type="button"
  class={['chip', { active, tinted: !!tint }]}
  style={tint ? `--tint: var(--${tint})` : undefined}
  aria-pressed={active}
  {onclick}
>
  <span class="label">{@render children()}</span>
  {#if count != null}<span class="count">{count}</span>{/if}
</button>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 12px;
    font-family: var(--font-ui);
    font-size: 12px;
    line-height: 1;
    white-space: nowrap;
    color: var(--fg-secondary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    cursor: pointer;
  }
  .chip:hover {
    color: var(--fg-primary);
  }
  .count {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .chip.active {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .chip.active .count {
    color: var(--accent);
  }
  .chip.tinted {
    color: var(--tint);
    background: var(--tint-surface);
    border-color: color-mix(in srgb, var(--tint) 40%, transparent);
  }
  .chip.tinted .count {
    color: var(--tint);
  }
</style>
