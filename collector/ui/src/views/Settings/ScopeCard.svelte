<script lang="ts">
  import * as api from '../../lib/api.js';
  import type { ScopeStatus } from '../../lib/api.js';
  import Button from '../../components/Button.svelte';

  // Capture scope editor (U5): which hosts are RECORDED. Out-of-scope traffic is
  // never stored (the proxy still forwards it). Loaded once from an attachment on
  // the root, like PairingCard: the attachment reads no reactive state, so it never
  // re-runs; a cancel flag guards a late resolve after unmount. Saving replaces
  // both lists on the collector (PUT /api/scope), which validates every pattern.
  type Status = 'loading' | 'ready' | 'unavailable';
  let status = $state<Status>('loading');
  let saved = $state<ScopeStatus | null>(null);
  let includeText = $state('');
  let excludeText = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let cancelled = false;

  function apply(scope: ScopeStatus): void {
    saved = scope;
    includeText = scope.include.join('\n');
    excludeText = scope.exclude.join('\n');
  }

  function load(): void {
    status = 'loading';
    api.fetchScope().then((scope) => {
      if (cancelled) return;
      if (scope) apply(scope);
      status = scope ? 'ready' : 'unavailable';
    });
  }

  function boot(): () => void {
    load();
    return () => { cancelled = true; };
  }

  const include = $derived(api.parsePatternLines(includeText));
  const exclude = $derived(api.parsePatternLines(excludeText));
  const dirty = $derived(
    saved != null && (include.join('\n') !== saved.include.join('\n') || exclude.join('\n') !== saved.exclude.join('\n')),
  );

  async function save(): Promise<void> {
    saving = true;
    error = null;
    notice = null;
    const r = await api.saveScope({ include, exclude });
    saving = false;
    if (cancelled) return;
    if (r.ok) {
      apply(r.scope);
      notice = 'Saved. Applies to new traffic; recorded entries are kept.';
    } else {
      error = r.message;
    }
  }

  function revert(): void {
    if (saved) apply(saved);
    error = null;
    notice = null;
  }
</script>

<section class="surface-card" {@attach boot} aria-label="Capture scope">
  <h2 class="title">Capture scope</h2>
  <p class="muted">
    Only matching hosts are recorded. Exclude wins over include; an empty include records every host.
    One pattern per line: <code>api.example.com</code>, <code>*.example.com</code>, <code>api.example.com/v1/*</code>.
  </p>

  {#if status === 'loading'}
    <p class="muted">Carregando…</p>
  {:else if status === 'unavailable'}
    <p class="muted">Scope unavailable.</p>
    <div><Button variant="secondary" size="sm" onclick={load}>Retry</Button></div>
  {:else}
    <div class="lists">
      <label class="field">
        <span class="label">Include</span>
        <textarea
          class="input"
          rows="5"
          spellcheck="false"
          placeholder="(every host)"
          data-testid="scope-include"
          bind:value={includeText}
        ></textarea>
      </label>
      <label class="field">
        <span class="label">Exclude</span>
        <textarea
          class="input"
          rows="5"
          spellcheck="false"
          placeholder="(nothing)"
          data-testid="scope-exclude"
          bind:value={excludeText}
        ></textarea>
      </label>
    </div>

    {#if error}
      <p class="error" role="alert" data-testid="scope-error">{error}</p>
    {:else if notice}
      <p class="notice" role="status">{notice}</p>
    {/if}

    <div class="actions">
      <Button size="sm" disabled={!dirty || saving} onclick={save} data-testid="scope-save">
        {saving ? 'Saving…' : 'Save'}
      </Button>
      <Button variant="ghost" size="sm" disabled={!dirty || saving} onclick={revert}>Revert</Button>
      <span class="dropped" data-testid="scope-dropped">
        not recorded since start: excluded {saved?.dropped.excluded ?? 0}
        <span class="sep">·</span> not included {saved?.dropped.notIncluded ?? 0}
      </span>
    </div>
  {/if}
</section>

<style>
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
    color: var(--fg-secondary);
  }
  code {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-primary);
  }
  .lists {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .label {
    font-size: 12px;
    color: var(--fg-secondary);
  }
  .input {
    resize: vertical;
    padding: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }
  .input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .error {
    margin: 0;
    font-size: 12px;
    color: var(--status-error);
    word-break: break-word;
  }
  .notice {
    margin: 0;
    font-size: 12px;
    color: var(--status-2xx);
  }
  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .dropped {
    margin-left: auto;
    font-size: 11px;
    color: var(--fg-muted);
  }
  .sep {
    color: var(--fg-muted);
  }
</style>
