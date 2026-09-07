<script lang="ts">
  import { statusBucket } from '../lib/format.js';

  type Props = { status: number | null; error?: string | null };
  let { status, error = null }: Props = $props();

  const bucket = $derived(statusBucket(status, error ?? null));
  const text = $derived(error ? 'ERR' : status == null ? '…' : String(status));
  // `1xx` has no dedicated colour token — it borrows the blue `--status-3xx` tint.
  const tintVar = $derived(
    bucket === 'error' ? 'status-error'
      : bucket === 'pending' ? 'status-pending'
        : bucket === '1xx' ? 'status-3xx'
          : `status-${bucket}`,
  );
</script>

<span class="status" data-bucket={bucket} style={`--tint: var(--${tintVar})`}>{text}</span>

<style>
  .status {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 34px;
    height: 20px;
    padding: 0 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1;
    color: var(--tint);
    background: var(--tint-surface);
    border-radius: var(--radius-sm);
  }
</style>
