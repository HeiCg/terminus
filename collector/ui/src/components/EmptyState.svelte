<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { title: string; hint?: string; action?: Snippet };
  let { title, hint, action }: Props = $props();
</script>

<div class="empty">
  <p class="title">{title}</p>
  {#if hint}<p class="hint">{hint}</p>{/if}
  {#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 100%;
    padding: 24px;
    text-align: center;
  }
  .title {
    margin: 0;
    font-family: var(--font-ui);
    font-size: 15px;
    color: var(--fg-primary);
  }
  .hint {
    margin: 0;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-secondary);
  }
  .action {
    margin-top: 6px;
  }
</style>
