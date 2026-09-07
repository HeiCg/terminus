<script lang="ts">
  import type { BodyOmission } from '../lib/protocol.js';
  import { fmtBytes } from '../lib/format.js';

  // The empty-body card shared by the HTTP body pane and the WS/SSE frame
  // inspector: one of the three terminal empties a body/frame can resolve to.
  // `label` names the thing that has no body ("request", "response", "frame").
  type Props =
    | { kind: 'absent'; label?: string }
    | { kind: 'omitted'; reason: BodyOmission; size: number; label?: string }
    | { kind: 'gone'; label?: string };
  let props: Props = $props();

  const label = $derived(props.label ?? 'body');

  const hint = $derived(
    props.kind !== 'omitted'
      ? ''
      : props.reason === 'size'
        ? 'Larger than the per-body cap.'
        : props.reason === 'binary'
          ? 'Binary content is not retained.'
          : props.reason === 'budget'
            ? 'Body budget exhausted; raise TERMINUS_BODY_BUDGET.'
            : 'Source did not capture this body.',
  );
</script>

{#if props.kind === 'absent'}
  <div class="card">
    <p class="card-title">No {label} body</p>
    <p class="card-hint">This {label} carried no body.</p>
  </div>
{:else if props.kind === 'omitted'}
  <div class="card">
    <svg class="card-icon" width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <circle cx="14" cy="14" r="9" stroke="currentColor" stroke-width="1.5" />
      <path d="M8 8l12 12" stroke="currentColor" stroke-width="1.5" />
    </svg>
    <p class="card-title">Body omitted — {props.reason}</p>
    <p class="card-hint">{hint}</p>
    <p class="card-size">{fmtBytes(props.size)}</p>
  </div>
{:else}
  <div class="card">
    <p class="card-title">Body no longer available</p>
    <p class="card-hint">The record was cleared from the collector.</p>
  </div>
{/if}

<style>
  .card {
    margin: 16px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    background: var(--bg-elevated);
    border-radius: 8px;
  }
  .card-icon {
    color: var(--fg-muted);
  }
  .card-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg-primary);
  }
  .card-hint {
    margin: 0;
    font-size: 12px;
    color: var(--fg-secondary);
  }
  .card-size {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
</style>
