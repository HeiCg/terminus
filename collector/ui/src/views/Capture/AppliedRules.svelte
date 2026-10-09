<script lang="ts">
  import type { EntrySummary } from '../../lib/protocol.js';

  // U6: the interception rules that ran on this entry, in order, and what the
  // device originally sent when a rewrite changed it. The entry itself shows the
  // request as sent upstream and the response as delivered to the device.
  type Props = { row: Pick<EntrySummary, 'rules' | 'mocked' | 'originalMethod' | 'originalUrl' | 'method' | 'url'> };
  let { row }: Props = $props();
</script>

<div class="applied" data-testid="applied-rules">
  <p class="lead">
    {#if row.mocked}
      Answered by an interception rule: no upstream was contacted.
    {:else}
      Changed by interception rules: shown as sent upstream and as delivered to the device.
    {/if}
  </p>
  <ol class="rules">
    {#each row.rules ?? [] as r, i (i)}
      <li><span class="name">{r.name}</span> <span class="what">{r.phase} {r.action}</span></li>
    {/each}
  </ol>
  {#if row.originalMethod != null || row.originalUrl != null}
    <p class="original" data-testid="original-request">
      <span class="label">Device sent</span>
      <span class="mono">{row.originalMethod ?? row.method} {row.originalUrl ?? row.url}</span>
    </p>
  {/if}
</div>

<style>
  .applied {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 16px 12px;
    font-size: 12px;
    color: var(--fg-secondary);
  }
  .lead {
    margin: 0;
  }
  .rules {
    margin: 0;
    padding-left: 18px;
  }
  .name {
    color: var(--fg-primary);
  }
  .what,
  .mono {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .original {
    margin: 0;
    display: flex;
    gap: 8px;
    word-break: break-all;
  }
  .label {
    flex: 0 0 auto;
  }
</style>
