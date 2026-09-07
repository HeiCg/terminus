<script lang="ts">
  // A WS/SSE session's liveness pill: `open` (tinted 2xx) while the socket is
  // live, `closed <code>` muted once it has closed. Shared by the session list
  // row and the frame-timeline header.
  type Props = { closedAt: number | null; closeCode?: number | null };
  let { closedAt, closeCode = null }: Props = $props();
</script>

{#if closedAt == null}
  <span class="pill open" style="--tint: var(--status-2xx)">open</span>
{:else}
  <span class="pill closed">closed{closeCode != null ? ` ${closeCode}` : ''}</span>
{/if}

<style>
  .pill {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 7px;
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1;
    border-radius: 999px;
  }
  .pill.open {
    color: var(--tint);
    background: var(--tint-surface);
  }
  .pill.closed {
    color: var(--fg-muted);
    background: var(--bg-elevated);
  }
</style>
