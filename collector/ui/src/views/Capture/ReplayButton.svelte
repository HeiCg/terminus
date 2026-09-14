<script lang="ts">
  // T7.1 UI affordance: re-send the selected request from the collector and show a
  // terse outcome. POST /api/replay rides the session cookie same-origin (the
  // browser supplies the Origin the collector's mutation guard requires). The
  // transient result is scoped to the current target so switching selection resets
  // it without a reactive effect (which the project forbids): a $derived key gates it.
  type Props = { deviceId: string; id: string };
  let { deviceId, id }: Props = $props();

  type State = 'idle' | 'sending' | 'done' | 'error';
  let phase = $state<State>('idle');
  let detail = $state('');
  let actedFor = $state('');

  const key = $derived(`${deviceId}::${id}`);
  // The result belongs to the selection it was fired for; a new selection reads idle.
  const shown = $derived(actedFor === key ? phase : 'idle');

  async function replay(): Promise<void> {
    if (phase === 'sending') return;
    actedFor = key;
    phase = 'sending';
    detail = '';
    try {
      const r = await fetch('/api/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ deviceId, id }),
      });
      if (r.ok) {
        const body = (await r.json()) as { status: number | null; error: string | null };
        phase = 'done';
        detail = body.error ? body.error : `sent · ${body.status ?? '—'}`;
      } else {
        phase = 'error';
        const text = (await r.text().catch(() => '')).slice(0, 80);
        detail = text || String(r.status);
      }
    } catch {
      phase = 'error';
      detail = 'request failed';
    }
  }
</script>

<button
  type="button"
  class="replay-btn"
  class:error={shown === 'error'}
  onclick={replay}
  disabled={shown === 'sending'}
  title="Re-send this request from the collector"
>
  {shown === 'sending' ? 'Replaying…' : 'Replay'}
  {#if shown !== 'idle' && shown !== 'sending' && detail}<span class="detail">{detail}</span>{/if}
</button>

<style>
  .replay-btn {
    height: 24px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-secondary);
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .replay-btn:hover:not(:disabled) {
    color: var(--fg-primary);
    background: var(--bg-elevated);
  }
  .replay-btn:disabled {
    cursor: default;
    opacity: 0.7;
  }
  .replay-btn.error {
    color: var(--status-error);
    border-color: currentColor;
  }
  .detail {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
</style>
