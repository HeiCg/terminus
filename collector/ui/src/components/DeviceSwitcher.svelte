<script lang="ts">
  import type { UiDevice } from '../lib/protocol.js';

  type Props = {
    devices: UiDevice[];
    value: string | 'all';
    onchange: (id: string | 'all') => void;
    now: number;
  };
  let { devices, value, onchange, now }: Props = $props();

  const short = (id: string) => id.slice(0, 6);
  const isApple = (platform: string) => /ios|apple|iphone|ipad|mac/i.test(platform);

  // The channel chips as compact text for a native <option> (which can hold no
  // markup): "ingest,atlantis". Empty when no channel has been observed yet.
  const channels = (d: UiDevice): string => {
    const parts: string[] = [];
    if (d.channels?.ingest) parts.push('ingest');
    if (d.channels?.atlantis) parts.push('atlantis');
    return parts.join(',');
  };

  const selected = $derived(value === 'all' ? null : (devices.find((d) => d.deviceId === value) ?? null));
  const live = $derived(selected ? now - selected.lastSeen < 30_000 : false);
</script>

<div class="switcher" class:live>
  {#if selected}
    <span class="glyph" aria-hidden="true">
      {#if isApple(selected.platform)}
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
          <path
            d="M16.4 12.6c0-2 1.6-3 1.7-3-.9-1.4-2.4-1.5-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.3 2-1.4 2.4-.4 6 1 8 .7 1 1.4 2 2.4 2 1 0 1.3-.6 2.5-.6s1.5.6 2.5.6 1.7-1 2.3-2c.7-1.1 1-2.2 1-2.3 0 0-2-.8-2.1-3.1zM14.6 6.3c.5-.7.9-1.6.8-2.5-.8 0-1.7.5-2.3 1.2-.5.6-.9 1.5-.8 2.4.9.1 1.8-.4 2.3-1.1z"
          />
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
          <path
            d="M6 9.5v6.5c0 .6.4 1 1 1h1v2.5a1.3 1.3 0 0 0 2.6 0V17h2.8v2.5a1.3 1.3 0 0 0 2.6 0V17h1c.6 0 1-.4 1-1V9.5H6zm-1.7 0A1.3 1.3 0 0 0 3 10.8v3.9a1.3 1.3 0 0 0 2.6 0v-3.9A1.3 1.3 0 0 0 4.3 9.5zm15.4 0a1.3 1.3 0 0 0-1.3 1.3v3.9a1.3 1.3 0 0 0 2.6 0v-3.9a1.3 1.3 0 0 0-1.3-1.3zM8.3 8.5h7.4c-.1-1.9-1.3-3.5-3-4.3l.9-1.6a.3.3 0 0 0-.5-.3l-1 1.7a5.6 5.6 0 0 0-4.1 0l-1-1.7a.3.3 0 0 0-.5.3l.9 1.6c-1.7.8-2.9 2.4-3 4.3zm1.6-2a.6.6 0 1 1 0-1.2.6.6 0 0 1 0 1.2zm4.2 0a.6.6 0 1 1 0-1.2.6.6 0 0 1 0 1.2z"
          />
        </svg>
      {/if}
    </span>
    <span class="id">{short(selected.deviceId)}</span>
    <span class="dot" aria-hidden="true"></span>
  {:else}
    <span class="id all">All</span>
  {/if}
  <span class="chev" aria-hidden="true">▾</span>

  <select
    class="native"
    aria-label="Select device"
    value={value}
    onchange={(e) => onchange((e.currentTarget as HTMLSelectElement).value)}
  >
    <option value="all">All devices</option>
    {#each devices as d (d.deviceId)}
      <option value={d.deviceId}>{short(d.deviceId)} · {d.platform}{channels(d) ? ` · ${channels(d)}` : ''}</option>
    {/each}
  </select>
</div>

<style>
  .switcher {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: 999px;
  }
  .glyph {
    display: inline-flex;
    align-items: center;
    color: var(--fg-secondary);
  }
  .id {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .id.all {
    font-family: var(--font-ui);
    color: var(--fg-secondary);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fg-muted);
  }
  .switcher.live .dot {
    background: var(--status-2xx);
  }
  .chev {
    color: var(--fg-muted);
    font-size: 10px;
  }
  /* Native <select> overlays the whole pill so the control stays fully keyboard
     and screen-reader accessible while the pill supplies the visual chrome. */
  .native {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
</style>
