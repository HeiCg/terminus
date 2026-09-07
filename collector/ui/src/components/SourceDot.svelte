<script lang="ts">
  type Props = { source: 'xhr' | 'atlantis' | 'proxy'; label?: boolean };
  let { source, label = false }: Props = $props();
</script>

<span class="wrap" title={label ? undefined : source} aria-label={label ? undefined : source}>
  <span class="dot" style={`--tint: var(--source-${source})`} aria-hidden="true"></span>
  {#if label}<span class="lbl">{source}</span>{/if}
</span>

<style>
  .wrap {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--tint);
  }
  .lbl {
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-secondary);
  }
</style>
