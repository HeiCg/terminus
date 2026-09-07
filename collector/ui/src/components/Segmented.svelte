<script lang="ts">
  type Option = { id: string; label: string };
  type Props = { options: Option[]; value: string; onchange: (id: string) => void };
  let { options, value, onchange }: Props = $props();
</script>

<div class="segmented" role="radiogroup">
  {#each options as opt (opt.id)}
    <button
      type="button"
      role="radio"
      class={['seg', { active: opt.id === value }]}
      aria-checked={opt.id === value}
      onclick={() => onchange(opt.id)}
    >{opt.label}</button>
  {/each}
</div>

<style>
  .segmented {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 28px;
    padding: 2px;
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
  .seg {
    display: inline-flex;
    align-items: center;
    height: 100%;
    padding: 0 10px;
    font-family: var(--font-ui);
    font-size: 12px;
    line-height: 1;
    white-space: nowrap;
    color: var(--fg-secondary);
    background: transparent;
    border: none;
    border-radius: calc(var(--radius-sm) - 2px);
    cursor: pointer;
  }
  .seg:hover {
    color: var(--fg-primary);
  }
  .seg.active {
    color: var(--fg-primary);
    background: var(--bg-elevated);
  }
</style>
