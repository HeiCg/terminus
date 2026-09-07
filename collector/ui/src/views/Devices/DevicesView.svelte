<script lang="ts">
  import { useStore, useClock } from '../../lib/context.js';
  import * as api from '../../lib/api.js';
  import EmptyState from '../../components/EmptyState.svelte';
  import DeviceCard from './DeviceCard.svelte';
  import PairingCard from './PairingCard.svelte';
  import RetentionCard from './RetentionCard.svelte';

  // Devices reads straight off the shared store — no per-mount projection to own,
  // so the view holds no disposable state (unlike Capture/Sockets). The Topbar now
  // lives in the App shell above every view, so this view renders no bar of its own.
  const store = useStore();
  const clock = useClock();

  // Per-device counters, folded once per store change rather than filtered per
  // card: walk entries and ws accumulating counts keyed by deviceId.
  const entryCounts = $derived.by(() => {
    const m = new Map<string, number>();
    for (const e of store.entries) m.set(e.deviceId, (m.get(e.deviceId) ?? 0) + 1);
    return m;
  });
  const wsCounts = $derived.by(() => {
    const m = new Map<string, number>();
    for (const w of store.ws) m.set(w.deviceId, (m.get(w.deviceId) ?? 0) + 1);
    return m;
  });

  // Oldest retained record's start time, for the retention card; null when empty.
  const oldestStartedAt = $derived.by(() => {
    let min: number | null = null;
    for (const e of store.entries) if (min == null || e.startedAt < min) min = e.startedAt;
    return min;
  });

  // clear() now rejects on failure; keep this fire-and-forget call from floating
  // as an unhandled rejection (a per-device clear has no toast surface here).
  function clearDevice(deviceId: string): void {
    void api.clear(deviceId).catch((e: unknown) => console.warn('Clear failed', e));
  }

  function exportDevice(deviceId: string): void {
    // The export route scopes by `?device=` (src/http.ts), so this downloads only
    // this device's exchanges. `window.open` (not a location assignment) so an
    // expired session's bare error status lands in a throwaway tab instead of
    // navigating the SPA away and dropping all in-memory capture state.
    window.open(`${api.exportUrl('har')}?device=${encodeURIComponent(deviceId)}`);
  }
</script>

<div class="devices">
  <div class="scroll">
    <h1 class="page-title">Devices</h1>

    {#if store.devices.length === 0}
      <EmptyState
        title="Nenhum device conectado"
        hint="Pareie um device usando o código ao lado."
      />
    {:else}
      <div class="grid" data-testid="device-grid">
        {#each store.devices as device (device.deviceId)}
          <DeviceCard
            {device}
            entries={entryCounts.get(device.deviceId) ?? 0}
            ws={wsCounts.get(device.deviceId) ?? 0}
            now={clock.now}
            onclear={() => clearDevice(device.deviceId)}
            onexport={() => exportDevice(device.deviceId)}
          />
        {/each}
      </div>
    {/if}

    <div class="lower">
      <PairingCard />
      <RetentionCard
        entries={store.entries.length}
        retention={store.retention}
        {oldestStartedAt}
      />
    </div>
  </div>
</div>

<style>
  .devices {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  /* A 20px page title inside the scrolled content — not a second top bar. */
  .page-title {
    margin: 0;
    font-family: var(--font-ui);
    font-size: 20px;
    font-weight: 600;
    color: var(--fg-primary);
  }
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 20px;
  }
  .lower {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 20px;
  }
</style>
