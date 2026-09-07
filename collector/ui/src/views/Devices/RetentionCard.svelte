<script lang="ts">
  import type { RetentionState } from '../../lib/state.js';
  import { MAX_ENTRIES, BODY_BYTES_CAP } from '../../lib/limits.js';
  import { fmtBytes, fmtTime } from '../../lib/format.js';

  // Live retention picture for the session: how full the entry ring and the body
  // budget are, the cumulative drop counters the collector reports, and the age
  // of the oldest record still kept. All inputs are projected by the view from
  // the shared store so this card stays a pure presenter.
  type Props = {
    entries: number;
    retention: RetentionState | null;
    oldestStartedAt: number | null;
  };
  let { entries, retention, oldestStartedAt }: Props = $props();

  const clamp = (frac: number): number => Math.max(0, Math.min(1, frac));
  const entriesFrac = $derived(clamp(entries / MAX_ENTRIES));
  const bodyBytes = $derived(retention?.retainedBodyBytes ?? 0);
  const bytesFrac = $derived(clamp(bodyBytes / BODY_BYTES_CAP));
</script>

<section class="surface-card" aria-label="Retention">
  <h2 class="title">Retention</h2>

  <div class="meter">
    <div class="meter-label">
      <span>entries</span>
      <span class="mono">{entries} / {MAX_ENTRIES}</span>
    </div>
    <div class="track"><div class="fill" style="width: {entriesFrac * 100}%"></div></div>
  </div>

  <div class="meter">
    <div class="meter-label">
      <span>bytes</span>
      <span class="mono">{fmtBytes(bodyBytes)} / {fmtBytes(BODY_BYTES_CAP)}</span>
    </div>
    <div class="track"><div class="fill" style="width: {bytesFrac * 100}%"></div></div>
  </div>

  <div class="dropped" data-testid="retention-dropped">
    dropped entries {retention?.droppedEntries ?? 0}
    <span class="sep">·</span> sessions {retention?.droppedSessions ?? 0}
    <span class="sep">·</span> frames {retention?.droppedFrames ?? 0}
    <span class="sep">·</span> omitted bodies {retention?.omittedBodies ?? 0}
  </div>

  <div class="oldest mono">
    Oldest kept: {oldestStartedAt == null ? '—' : fmtTime(oldestStartedAt)}
  </div>
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
  .meter {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .meter-label {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--fg-secondary);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .track {
    height: 6px;
    border-radius: 999px;
    background: var(--bg-elevated);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    border-radius: 999px;
  }
  .dropped {
    font-size: 11px;
    color: var(--fg-muted);
  }
  .sep {
    color: var(--fg-muted);
  }
  .oldest {
    font-size: 11px;
    color: var(--fg-muted);
  }
</style>
