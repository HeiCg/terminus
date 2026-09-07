<script lang="ts">
  import type { UiDevice } from '../../lib/protocol.js';
  import { fmtRelative } from '../../lib/format.js';
  import Button from '../../components/Button.svelte';

  // One connected device. Counters (entries/ws) are projected by the view from
  // the shared store; `dropped` rides on the device record itself. `now` is the
  // shared clock so the live dot and "last seen" re-render on each tick without a
  // per-card timer.
  type Props = {
    device: UiDevice;
    entries: number;
    ws: number;
    now: number;
    onclear: () => void;
    onexport: () => void;
  };
  let { device, entries, ws, now, onclear, onexport }: Props = $props();

  // A device is live if it was heard from inside the last 30 s; otherwise the row
  // reads as last-seen with a relative age.
  const live = $derived(now - device.lastSeen < 30_000);
  const shortId = $derived(device.deviceId.slice(0, 6));
  const isQa = $derived(device.buildProfile === 'qa');

  // Coarse platform family for the glyph: apple, android, or a generic phone.
  const platform = $derived.by(() => {
    const p = device.platform.toLowerCase();
    if (p.includes('ios') || p.includes('apple') || p.includes('mac')) return 'apple';
    if (p.includes('android')) return 'android';
    return 'generic';
  });
</script>

<div class="surface-card" data-testid="device-card" data-live={live}>
  <div class="line id-line">
    <span class="glyph" role="img" title={device.platform} aria-label={device.platform}>
      {#if platform === 'apple'}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M11 8.6c0-1.7 1.4-2.5 1.5-2.6-0.8-1.2-2.1-1.3-2.5-1.3-1.1-0.1-2.1 0.6-2.6 0.6s-1.4-0.6-2.3-0.6c-1.2 0-2.3 0.7-2.9 1.8-1.2 2.1-0.3 5.3 0.9 7 0.6 0.8 1.3 1.8 2.2 1.7 0.9 0 1.2-0.6 2.3-0.6s1.4 0.6 2.3 0.5c0.9 0 1.5-0.8 2.1-1.7 0.7-1 0.9-1.9 0.9-2-0.1 0-1.8-0.7-1.9-2.5zM9.6 3.9c0.5-0.6 0.8-1.4 0.7-2.2-0.7 0-1.5 0.5-2 1-0.4 0.5-0.8 1.3-0.7 2.1 0.8 0.1 1.5-0.4 2-0.9z" />
        </svg>
      {:else if platform === 'android'}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4.5 6.5c-0.4 0-0.7 0.3-0.7 0.7v3.1c0 0.4 0.3 0.7 0.7 0.7s0.7-0.3 0.7-0.7V7.2c0-0.4-0.3-0.7-0.7-0.7zM11.5 6.5c-0.4 0-0.7 0.3-0.7 0.7v3.1c0 0.4 0.3 0.7 0.7 0.7s0.7-0.3 0.7-0.7V7.2c0-0.4-0.3-0.7-0.7-0.7zM5.6 6.1h4.8v4.9c0 0.3-0.3 0.6-0.6 0.6H9v1.6c0 0.4-0.3 0.7-0.7 0.7s-0.7-0.3-0.7-0.7v-1.6H7.4v1.6c0 0.4-0.3 0.7-0.7 0.7S6 13.5 6 13.1v-1.6h-0.8c-0.3 0-0.6-0.3-0.6-0.6V6.1zM10.3 5.5H5.7c0.1-1 0.7-1.9 1.5-2.4l-0.6-0.9c-0.1-0.1 0-0.2 0.1-0.3 0.1-0.1 0.2 0 0.3 0.1l0.6 1c0.4-0.2 0.8-0.3 1.3-0.3s0.9 0.1 1.3 0.3l0.6-1c0.1-0.1 0.2-0.1 0.3-0.1 0.1 0.1 0.1 0.2 0.1 0.3l-0.6 0.9c0.8 0.5 1.4 1.4 1.5 2.4zM7 4.2c0.2 0 0.4-0.2 0.4-0.4s-0.2-0.4-0.4-0.4-0.4 0.2-0.4 0.4 0.2 0.4 0.4 0.4zM9 4.2c0.2 0 0.4-0.2 0.4-0.4s-0.2-0.4-0.4-0.4-0.4 0.2-0.4 0.4 0.2 0.4 0.4 0.4z" />
        </svg>
      {:else}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M5 1.5h6c0.6 0 1 0.4 1 1v11c0 0.6-0.4 1-1 1H5c-0.6 0-1-0.4-1-1v-11c0-0.6 0.4-1 1-1zM5 3v9h6V3H5zm2.2 9.6h1.6c0.2 0 0.3 0.1 0.3 0.3s-0.1 0.3-0.3 0.3H7.2c-0.2 0-0.3-0.1-0.3-0.3s0.1-0.3 0.3-0.3z" />
        </svg>
      {/if}
    </span>
    <span class="dev-id">{shortId}</span>
    <span class={['profile', { qa: isQa }]}>{device.buildProfile}</span>
  </div>

  <div class="line version">v{device.appVersion}</div>

  <div class="line seen">
    <span class={['dot', { live }]} aria-hidden="true"></span>
    {#if live}
      <span>seen {fmtRelative(device.lastSeen, now)}</span>
    {:else}
      <span>last seen {fmtRelative(device.lastSeen, now)}</span>
    {/if}
  </div>

  <div class="line counters" data-testid="device-counters">
    <span>entries {entries}</span>
    <span class="sep">·</span>
    <span>ws {ws}</span>
    <span class="sep">·</span>
    <span class={['dropped', { hot: device.dropped > 0 }]}>dropped {device.dropped}</span>
  </div>

  <div class="actions">
    <Button variant="ghost" size="sm" onclick={onclear}>Clear device</Button>
    <Button variant="secondary" size="sm" onclick={onexport} title="Export HAR for this device">Export HAR</Button>
  </div>
</div>

<style>
  /* Frame comes from the global `.surface-card`; this card packs its lines tighter. */
  .surface-card {
    gap: 8px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .id-line {
    gap: 8px;
  }
  .glyph {
    display: inline-flex;
    align-items: center;
    color: var(--fg-secondary);
  }
  .dev-id {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--fg-primary);
  }
  .profile {
    margin-left: auto;
    padding: 2px 8px;
    font-family: var(--font-ui);
    font-size: 11px;
    line-height: 1.4;
    border-radius: 999px;
    color: var(--fg-muted);
    background: var(--bg-elevated);
  }
  .profile.qa {
    --tint: var(--accent);
    color: var(--accent);
    background: var(--tint-surface);
  }
  .version {
    font-size: 12px;
    color: var(--fg-secondary);
  }
  .seen {
    font-size: 12px;
    color: var(--fg-secondary);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fg-muted);
  }
  .dot.live {
    background: var(--status-2xx);
  }
  .counters {
    gap: 6px;
    font-size: 11px;
    color: var(--fg-muted);
  }
  .sep {
    color: var(--fg-muted);
  }
  .dropped.hot {
    color: var(--status-5xx);
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }
</style>
