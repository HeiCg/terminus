<script lang="ts">
  type Props = { kind: 'ws' | 'sse' | 'xhr' };
  let { kind }: Props = $props();

  const tintVar = $derived(kind === 'ws' ? 'kind-ws' : kind === 'sse' ? 'kind-sse' : 'source-xhr');
</script>

<span class="kind" style={`--tint: var(--${tintVar})`}>{kind.toUpperCase()}</span>

<style>
  .kind {
    display: inline-flex;
    align-items: center;
    height: 16px;
    padding: 0 5px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    line-height: 1;
    text-transform: uppercase;
    color: var(--tint);
    background: var(--tint-surface);
    border-radius: 999px;
  }
</style>
