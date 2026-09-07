<script lang="ts">
  import { fmtMs } from '../lib/format.js';

  type Props = { durationMs: number | null };
  let { durationMs }: Props = $props();
</script>

<div class="timing">
  <div class="track" aria-hidden="true">
    <span class="seg"></span>
  </div>
  <div class="legend">
    <span class="label">total</span>
    <span class="value">{fmtMs(durationMs)}</span>
  </div>
  <p class="note">Phase breakdown not available from this source</p>
</div>

<style>
  .timing {
    padding: 16px;
  }
  .track {
    height: 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    overflow: hidden;
  }
  .seg {
    display: block;
    width: 100%;
    height: 100%;
    background: var(--accent);
  }
  .legend {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .label {
    color: var(--fg-secondary);
  }
  .value {
    color: var(--fg-primary);
  }
  .note {
    margin: 12px 0 0;
    font-family: var(--font-ui);
    font-size: 11px;
    color: var(--fg-muted);
  }
</style>
