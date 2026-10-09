<script lang="ts">
  // U7: `tcp`/`tls` badge raw stream sessions in the Sockets view.
  type Props = { kind: 'ws' | 'sse' | 'xhr' | 'tcp' | 'tls' };
  let { kind }: Props = $props();

  const tintVar = $derived(kind === 'xhr' ? 'source-xhr' : `kind-${kind}`);
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
