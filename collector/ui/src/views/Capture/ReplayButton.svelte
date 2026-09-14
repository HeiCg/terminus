<script lang="ts">
  // T7.1/T8.1 UI affordance: re-send the selected request from the collector and
  // show a terse outcome. POST /api/replay rides the session cookie same-origin (the
  // browser supplies the Origin the collector's mutation guard requires). The
  // transient result is scoped to the current target so switching selection resets
  // it without a reactive effect (which the project forbids): a $derived key gates it.
  //
  // Credentials are stripped by default (T8.1). "Include captured credentials" opts
  // into re-sending them; because that is dangerous, the first click only arms an
  // inline confirmation (the label becomes "Replay with credentials") and a second
  // click sends — no window.confirm. After a replay the names that were stripped are
  // listed when non-empty.
  type Props = { deviceId: string; id: string };
  let { deviceId, id }: Props = $props();

  type State = 'idle' | 'sending' | 'done' | 'error';
  let phase = $state<State>('idle');
  let detail = $state('');
  let stripped = $state<string[]>([]);
  let actedFor = $state('');
  let withCreds = $state(false);
  // Key of the selection whose credentialed replay is armed; '' when disarmed.
  let confirmFor = $state('');

  const key = $derived(`${deviceId}::${id}`);
  // The result belongs to the selection it was fired for; a new selection reads idle.
  const shown = $derived(actedFor === key ? phase : 'idle');
  // The confirmation is armed only for the current selection.
  const armed = $derived(confirmFor === key);
  const label = $derived(shown === 'sending' ? 'Replaying…' : armed ? 'Replay with credentials' : 'Replay');

  // Toggling the checkbox disarms any pending confirmation (the intent changed).
  function onToggle(e: Event): void {
    withCreds = (e.currentTarget as HTMLInputElement).checked;
    confirmFor = '';
  }

  async function onClick(): Promise<void> {
    if (phase === 'sending') return;
    // A credentialed replay needs a confirming second click; the first only arms it.
    if (withCreds && !armed) { confirmFor = key; return; }
    confirmFor = '';
    await send();
  }

  async function send(): Promise<void> {
    actedFor = key;
    phase = 'sending';
    detail = '';
    stripped = [];
    try {
      const r = await fetch('/api/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ deviceId, id, credentials: withCreds ? 'keep' : 'strip' }),
      });
      if (r.ok) {
        const body = (await r.json()) as { status: number | null; error: string | null; stripped?: string[] };
        phase = 'done';
        detail = body.error ? body.error : `sent · ${body.status ?? '—'}`;
        stripped = body.stripped ?? [];
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

<span class="replay">
  <button
    type="button"
    class="replay-btn"
    class:error={shown === 'error'}
    class:armed
    onclick={onClick}
    disabled={shown === 'sending'}
    title="Re-send this request from the collector"
  >
    {label}
    {#if shown !== 'idle' && shown !== 'sending' && detail}<span class="detail">{detail}</span>{/if}
  </button>
  <label class="creds" title="Re-send the authorization/cookie headers and token query params that were captured">
    <input type="checkbox" checked={withCreds} onchange={onToggle} />
    Include captured credentials
  </label>
  {#if shown === 'done' && stripped.length}<span class="stripped">stripped: {stripped.join(', ')}</span>{/if}
</span>

<style>
  .replay {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
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
  .replay-btn.armed {
    color: var(--status-error);
    border-color: currentColor;
  }
  .creds {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-ui);
    font-size: 11px;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .detail {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .stripped {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
</style>
