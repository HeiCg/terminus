<script lang="ts">
  import type { Selection } from '../../lib/state/Selection.svelte.js';

  type Props = { selection: Selection };
  let { selection }: Props = $props();

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(selection.curl);
    } catch {
      /* clipboard unavailable */
    }
  }
</script>

<div class="curl">
  <div class="toolbar">
    <button type="button" class="ghost" onclick={copy}>Copy</button>
  </div>
  <pre class="cmd"><code>{selection.curl}</code></pre>
</div>

<style>
  .curl {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    height: 40px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .ghost {
    height: 28px;
    padding: 0 10px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .ghost:hover {
    color: var(--fg-primary);
    background: var(--bg-elevated);
  }
  .cmd {
    margin: 0;
    padding: 16px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg-primary);
    white-space: pre-wrap;
    word-break: break-word;
    overflow: auto;
  }
</style>
