<script lang="ts">
  import type { EntrySummary } from '../../lib/protocol.js';
  import { fmtBytes, fmtTime } from '../../lib/format.js';

  // A proxy CONNECT entry for a TLS tunnel passed through WITHOUT interception
  // (U5): nothing inside it is visible, so this strip shows what is known about
  // the connection instead of headers and bodies.
  type Props = { tunnel: NonNullable<EntrySummary['tunnel']> };
  let { tunnel }: Props = $props();
</script>

<div class="tunnel" data-testid="tunnel-info">
  <p class="lead">TLS tunnel, not intercepted. Headers and bodies inside it are not visible.</p>
  <dl class="grid">
    <dt>Destination</dt>
    <dd>{tunnel.host}:{tunnel.port}</dd>
    <dt>SNI</dt>
    <dd>{tunnel.sni ?? '—'}</dd>
    <dt>Bytes up / down</dt>
    <dd>{fmtBytes(tunnel.bytesUp)} / {fmtBytes(tunnel.bytesDown)}</dd>
    <dt>Opened</dt>
    <dd>{fmtTime(tunnel.openedAt)}</dd>
    <dt>Closed</dt>
    <dd>{tunnel.closedAt == null ? 'open' : fmtTime(tunnel.closedAt)}</dd>
  </dl>
</div>

<style>
  .tunnel {
    --tint: var(--source-proxy);
    margin: 0 16px 12px;
    padding: 10px 12px;
    background: var(--tint-surface);
    border-radius: var(--radius-sm);
  }
  .lead {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--fg-primary);
  }
  .grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
    margin: 0;
    font-size: 12px;
  }
  dt {
    color: var(--fg-secondary);
  }
  dd {
    margin: 0;
    font-family: var(--font-mono);
    color: var(--fg-primary);
    word-break: break-all;
  }
</style>
