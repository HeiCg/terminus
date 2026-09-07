<script lang="ts">
  type Tab = { id: string; label: string };
  type Props = { tabs: Tab[]; value: string; onchange: (id: string) => void };
  let { tabs, value, onchange }: Props = $props();
</script>

<div class="tabs" role="tablist">
  {#each tabs as tab (tab.id)}
    <button
      type="button"
      role="tab"
      class={['tab', { active: tab.id === value }]}
      aria-selected={tab.id === value}
      onclick={() => onchange(tab.id)}
    >{tab.label}</button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    align-items: stretch;
    gap: 4px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .tab {
    position: relative;
    padding: 8px 10px;
    font-family: var(--font-ui);
    font-size: 13px;
    line-height: 1;
    color: var(--fg-secondary);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    cursor: pointer;
  }
  .tab:hover {
    color: var(--fg-primary);
  }
  .tab.active {
    color: var(--fg-primary);
    border-bottom-color: var(--accent);
  }
</style>
