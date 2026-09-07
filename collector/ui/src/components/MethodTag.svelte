<script lang="ts">
  type Props = { method: string };
  let { method }: Props = $props();

  const m = $derived(method.toUpperCase());
  const tintVar = $derived(
    m === 'GET'
      ? 'status-3xx'
      : m === 'POST'
        ? 'status-2xx'
        : m === 'PUT' || m === 'PATCH'
          ? 'status-4xx'
          : m === 'DELETE'
            ? 'status-5xx'
            : 'fg-secondary',
  );
</script>

<span class="method" style={`--tint: var(--${tintVar})`}>{m}</span>

<style>
  .method {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 5px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.02em;
    line-height: 1;
    text-transform: uppercase;
    color: var(--tint);
    background: var(--bg-elevated);
    border-radius: var(--radius-sm);
  }
</style>
