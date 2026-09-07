<script lang="ts">
  import * as api from '../../lib/api.js';
  import type { PairingInfo } from '../../lib/api.js';
  import { buildQrPayload } from '../../lib/pairing.js';
  import { encodeQr } from '../../lib/qr.js';
  import QrGrid from '../../components/QrGrid.svelte';
  import Button from '../../components/Button.svelte';

  // The pairing blob is fetched imperatively, ONCE, from an attachment on the
  // root: the attachment reads no reactive state, so Svelte never re-runs it. It
  // writes the result into local $state and a cancel flag guards a late resolve
  // after unmount. `Retry` re-invokes the same load (a user gesture, not a
  // reactive re-run) so a not-yet-minted identity can be picked up without a
  // full remount.
  type Status = 'loading' | 'ready' | 'unavailable';
  let status = $state<Status>('loading');
  let pairing = $state<PairingInfo | null>(null);
  let copied = $state(false);
  let cancelled = false;
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  function load(): void {
    status = 'loading';
    api.fetchPairing().then((info) => {
      if (cancelled) return;
      pairing = info;
      status = info ? 'ready' : 'unavailable';
    });
  }

  // The attachment: run the fetch on mount, cancel a pending resolve on unmount.
  function boot(): () => void {
    load();
    return () => {
      cancelled = true;
      if (copyTimer !== null) clearTimeout(copyTimer);
    };
  }

  // The QR payload the app scans: the collector's compact `QrPairing` blob, whose
  // exact bytes the app cross-checks against a shared fixture. encodeQr can throw
  // if a pathologically long host pushes the blob past capacity — degrade to the
  // textual code rather than break the card.
  const matrix = $derived.by(() => {
    if (!pairing) return null;
    try {
      return encodeQr(buildQrPayload(pairing));
    } catch {
      return null;
    }
  });

  // The human-typed code: first 6 hex of the cert fingerprint, upper-cased and
  // grouped 3+3 (e.g. `A1B C2D`).
  const code = $derived.by(() => {
    if (!pairing) return '';
    const hex = pairing.certificateSha256.slice(0, 6).toUpperCase();
    return `${hex.slice(0, 3)} ${hex.slice(3, 6)}`;
  });

  const address = $derived(pairing ? `${pairing.host}:${pairing.ingestPort}` : '');

  async function copyAddress(): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      copied = true;
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = false; copyTimer = null; }, 1500);
    } catch {
      /* clipboard blocked (insecure context / denied) — no-op */
    }
  }
</script>

<section class="surface-card" {@attach boot} aria-label="Pair a device">
  <h2 class="title">Pair a device</h2>

  {#if status === 'loading'}
    <p class="muted">Carregando…</p>
  {:else if status === 'unavailable' || !pairing}
    <p class="muted unavailable">Pairing unavailable (identity not ready)</p>
    <div class="retry">
      <Button variant="ghost" size="sm" onclick={load}>Retry</Button>
    </div>
  {:else}
    <div class="body">
      <div class="left">
        <div class="address">
          <code class="addr-text">{address}</code>
          <Button variant="ghost" size="sm" onclick={copyAddress}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>

        <div class="code-block">
          <span class="label">PAIRING CODE</span>
          <span class="code" data-testid="pairing-code">{code}</span>
          <span class="caption">rotates when the collector restarts</span>
        </div>
      </div>

      <div class="qr">
        {#if matrix}
          <QrGrid {matrix} size={96} />
        {:else}
          <p class="muted qr-note">QR unavailable — payload too large</p>
        {/if}
      </div>
    </div>

    <ol class="steps">
      <li><span class="step-n">1</span> Abra o app → Settings</li>
      <li><span class="step-n">2</span> Network Capture</li>
      <li><span class="step-n">3</span> Digite o código acima ou escaneie</li>
    </ol>
  {/if}
</section>

<style>
  /* Frame comes from the global `.surface-card`; local gap only. */
  .surface-card {
    gap: 12px;
  }
  .title {
    margin: 0;
    font-family: var(--font-ui);
    font-size: 15px;
    font-weight: 600;
    color: var(--fg-primary);
  }
  .muted {
    margin: 0;
    font-size: 12px;
    color: var(--fg-muted);
  }
  .retry {
    margin-top: 4px;
  }
  .body {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    justify-content: space-between;
  }
  .left {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .address {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 10px;
    background: var(--bg-elevated);
    border-radius: var(--radius-sm);
  }
  .addr-text {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .code-block {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .label {
    font-family: var(--font-ui);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }
  .code {
    font-family: var(--font-mono);
    font-size: 28px;
    letter-spacing: 0.04em;
    color: var(--fg-primary);
  }
  .caption {
    font-size: 11px;
    color: var(--fg-muted);
  }
  .qr {
    flex: 0 0 auto;
  }
  .qr-note {
    max-width: 96px;
    text-align: right;
  }
  .steps {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--fg-secondary);
  }
  .step-n {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
    background: var(--bg-elevated);
    border-radius: 50%;
  }
</style>
