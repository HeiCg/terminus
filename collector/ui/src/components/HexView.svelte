<script lang="ts">
  import { HEX_PAGE_BYTES, hexRows, bytesToHex, bytesToBase64 } from '../lib/bytes.js';
  import { fmtBytes } from '../lib/format.js';

  // Read-only hex dump (U4): offset | 16 hex bytes | ASCII, shared by the Capture
  // body pane and the Sockets frame inspector. Rows are built on demand for the
  // first `shown` bytes only (one 4 KiB page at a time, "Show more" adds a page),
  // so a 1 MiB body never renders 65 536 rows up front. Each row is three text
  // runs, not one node per byte. The component is keyed by its parent per body,
  // so `shown` resets for a new body without a reactive effect.
  type Props = { bytes: Uint8Array; label?: string; testid?: string };
  let { bytes, label = 'body', testid = 'hex-view' }: Props = $props();

  let shown = $state(HEX_PAGE_BYTES);
  let copied = $state<'hex' | 'base64' | null>(null);

  const rows = $derived(hexRows(bytes, 0, Math.min(shown, bytes.length)));
  const remaining = $derived(Math.max(0, bytes.length - shown));

  async function copy(kind: 'hex' | 'base64'): Promise<void> {
    const text = kind === 'hex' ? bytesToHex(bytes) : bytesToBase64(bytes);
    try {
      await navigator.clipboard?.writeText(text);
      copied = kind;
      setTimeout(() => { if (copied === kind) copied = null; }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  }
</script>

<div class="hexview" data-testid={testid}>
  <div class="bar">
    <span class="count" data-testid="hex-count">{bytes.length} bytes · {fmtBytes(bytes.length)}</span>
    <button type="button" class="ghost" onclick={() => copy('hex')}>{copied === 'hex' ? 'Copied' : 'Copy hex'}</button>
    <button type="button" class="ghost" onclick={() => copy('base64')}>{copied === 'base64' ? 'Copied' : 'Copy base64'}</button>
  </div>
  {#if bytes.length === 0}
    <p class="empty">No bytes.</p>
  {:else}
    <div class="dump" role="table" aria-label={`Hex dump of the ${label}`}>
      <div class="row head" role="row">
        <span class="off" role="columnheader">Offset</span>
        <span class="hex" role="columnheader">Hex</span>
        <span class="ascii" role="columnheader">ASCII</span>
      </div>
      {#each rows as r (r.offset)}
        <div class="row" role="row" data-testid="hex-row">
          <span class="off" role="rowheader">{r.label}</span>
          <span class="hex" role="cell">{r.hex}</span>
          <span class="ascii" role="cell">{r.ascii}</span>
        </div>
      {/each}
    </div>
    {#if remaining > 0}
      <div class="more">
        <button type="button" class="ghost bordered" onclick={() => (shown += HEX_PAGE_BYTES)}>
          Show next {fmtBytes(Math.min(HEX_PAGE_BYTES, remaining))}
        </button>
        <span class="hint">{fmtBytes(shown)} of {fmtBytes(bytes.length)} shown</span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .hexview {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .count {
    margin-right: auto;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .ghost {
    height: 24px;
    padding: 0 8px;
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
  .ghost.bordered {
    border: 1px solid var(--border-subtle);
  }
  .dump {
    padding: 8px 12px;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 18px;
  }
  .row {
    display: flex;
    gap: 16px;
    white-space: pre;
  }
  .row.head {
    color: var(--fg-muted);
    font-size: 11px;
  }
  /* Fixed character widths keep the header aligned with the data columns:
     8 offset digits, 16 pairs + 15 gaps + the mid-row gap = 48. */
  .off {
    flex: 0 0 8ch;
    color: var(--fg-muted);
  }
  .hex {
    flex: 0 0 48ch;
    color: var(--fg-primary);
  }
  .ascii {
    flex: 0 0 auto;
    color: var(--fg-secondary);
  }
  .row.head .hex,
  .row.head .ascii {
    color: var(--fg-muted);
  }
  .more {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px 12px;
  }
  .hint,
  .empty {
    font-size: 11px;
    color: var(--fg-muted);
  }
  .empty {
    margin: 0;
    padding: 12px;
  }
</style>
