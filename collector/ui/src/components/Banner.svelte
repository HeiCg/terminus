<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { kind: 'info' | 'warning' | 'error'; ondismiss?: () => void; children: Snippet };
  let { kind, ondismiss, children }: Props = $props();

  const tintVar = $derived(kind === 'info' ? 'accent' : kind === 'warning' ? 'status-4xx' : 'status-5xx');
</script>

<div class="banner" data-kind={kind} style={`--tint: var(--${tintVar})`} role="status">
  <span class="msg">{@render children()}</span>
  {#if ondismiss}
    <button type="button" class="dismiss" aria-label="Dismiss" onclick={ondismiss}>×</button>
  {/if}
</div>

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 36px;
    padding: 0 12px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-primary);
    background: var(--tint-surface);
    border-left: 2px solid var(--tint);
  }
  .msg {
    flex: 1 1 auto;
    min-width: 0;
  }
  .dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    font-size: 15px;
    line-height: 1;
    color: var(--fg-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .dismiss:hover {
    color: var(--fg-primary);
    background: var(--bg-elevated);
  }
</style>
