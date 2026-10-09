<script lang="ts">
  import type { RuleDraft } from '../../lib/state/RuleDraft.svelte.js';
  import type { RuleActionType, RulePhase } from '../../lib/ruleModel.js';
  import Button from '../../components/Button.svelte';

  // The form for one interception rule (U6): match criteria, phase and one action,
  // with the fields of the chosen action. Validation is the shared rule model, run
  // live by the draft; the first problem is shown under its field and Save stays
  // off until the rule is valid. `error` is the collector's answer to a save.
  type Props = {
    draft: RuleDraft;
    isNew: boolean;
    busy: boolean;
    error: string | null;
    onsubmit: () => void;
    oncancel: () => void;
  };
  let { draft, isNew, busy, error, onsubmit, oncancel }: Props = $props();

  const ACTION_LABEL: Record<RuleActionType, string> = { block: 'Block', mock: 'Mock response', rewrite: 'Rewrite', delay: 'Delay' };
  const problem = $derived(draft.check.ok ? null : draft.check);

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    onsubmit();
  }
</script>

{#snippet fieldError(field: string, exact = false)}
  {@const msg = draft.errorFor(field, exact)}
  {#if msg}<span class="field-error" data-testid={`rule-error-${field}`}>{msg}</span>{/if}
{/snippet}

<form class="rule-form" onsubmit={submit} aria-label={isNew ? 'New rule' : 'Edit rule'} data-testid="rule-form">
  <div class="row two">
    <label class="field">
      <span class="label">Name</span>
      <input class="input" data-testid="rule-name" bind:value={draft.name} placeholder="Mock login" />
      {@render fieldError('name')}
    </label>
    <label class="field">
      <span class="label">Phase</span>
      <select
        class="input"
        data-testid="rule-phase"
        value={draft.phase}
        onchange={(e) => draft.setPhase(e.currentTarget.value as RulePhase)}
      >
        <option value="request">Request (before upstream)</option>
        <option value="response">Response (before the device)</option>
      </select>
    </label>
  </div>

  <fieldset class="group">
    <legend>Match <span class="hint">(the device's request, before any rewrite; empty fields match anything)</span></legend>
    <div class="row three">
      <label class="field">
        <span class="label">Methods</span>
        <input class="input mono" data-testid="rule-methods" bind:value={draft.methods} placeholder="GET, POST" />
        {@render fieldError('match.methods')}
      </label>
      <label class="field">
        <span class="label">Host</span>
        <input class="input mono" data-testid="rule-host" bind:value={draft.host} placeholder="api.example.com or *.example.com" />
        {@render fieldError('match.host')}
      </label>
      <label class="field">
        <span class="label">Scheme</span>
        <select class="input" data-testid="rule-scheme" bind:value={draft.scheme}>
          <option value="">any</option>
          <option value="http">http</option>
          <option value="https">https</option>
        </select>
      </label>
    </div>
    <label class="field">
      <span class="label">Path <span class="hint">(glob: <code>*</code> any run, <code>?</code> one character)</span></span>
      <input class="input mono" data-testid="rule-path" bind:value={draft.path} placeholder="/v1/users/*" />
      {@render fieldError('match.path')}
    </label>
    <div class="row two">
      <label class="field">
        <span class="label">Query <span class="hint">(one <code>name=glob</code> per line)</span></span>
        <textarea class="input mono" rows="2" data-testid="rule-query" bind:value={draft.query}></textarea>
        {@render fieldError('match.query')}
      </label>
      <label class="field">
        <span class="label">Headers <span class="hint">(one <code>Name: glob</code> per line)</span></span>
        <textarea class="input mono" rows="2" data-testid="rule-headers" bind:value={draft.headers}></textarea>
        {@render fieldError('match.headers')}
      </label>
    </div>
  </fieldset>

  <fieldset class="group">
    <legend>Action</legend>
    <label class="field narrow">
      <span class="label">Type</span>
      <select class="input" data-testid="rule-action" bind:value={draft.actionType}>
        {#each draft.actions as a (a)}
          <option value={a}>{ACTION_LABEL[a]}</option>
        {/each}
      </select>
      {@render fieldError('action.type')}
    </label>

    {#if draft.actionType === 'block'}
      <div class="row three">
        <label class="field">
          <span class="label">How</span>
          <select class="input" data-testid="rule-block-mode" bind:value={draft.blockMode}>
            <option value="status">Answer with a status</option>
            <option value="close">Close the connection</option>
            <option value="reset">Reset the connection</option>
          </select>
          {@render fieldError('action.close')}
          {@render fieldError('action.reset')}
        </label>
        {#if draft.blockMode === 'status'}
          <label class="field">
            <span class="label">Status</span>
            <input class="input mono" data-testid="rule-status" bind:value={draft.status} placeholder="403" />
            {@render fieldError('action.status')}
          </label>
        {/if}
      </div>
      {#if draft.blockMode === 'status'}
        <label class="field">
          <span class="label">Body</span>
          <textarea class="input mono" rows="2" data-testid="rule-body" bind:value={draft.body}></textarea>
          {@render fieldError('action.body')}
        </label>
      {/if}
    {:else if draft.actionType === 'mock'}
      <div class="row three">
        <label class="field">
          <span class="label">Status</span>
          <input class="input mono" data-testid="rule-status" bind:value={draft.status} placeholder="200" />
          {@render fieldError('action.status')}
        </label>
        <label class="field">
          <span class="label">Delay (ms)</span>
          <input class="input mono" data-testid="rule-mock-delay" bind:value={draft.mockDelay} placeholder="0" />
          {@render fieldError('action.delayMs')}
        </label>
      </div>
      <label class="field">
        <span class="label">Headers <span class="hint">(one <code>Name: value</code> per line)</span></span>
        <textarea class="input mono" rows="2" data-testid="rule-mock-headers" bind:value={draft.mockHeaders}></textarea>
        {@render fieldError('action.headers')}
      </label>
      {@render bodyField()}
    {:else if draft.actionType === 'rewrite'}
      {#if draft.phase === 'request'}
        <div class="row two">
          <label class="field">
            <span class="label">URL <span class="hint">(absolute, or a path to keep the host)</span></span>
            <input class="input mono" data-testid="rule-url" bind:value={draft.url} placeholder="/v2/users or https://staging.example.com/api" />
            {@render fieldError('action.url')}
          </label>
          <label class="field">
            <span class="label">Method</span>
            <input class="input mono" data-testid="rule-method" bind:value={draft.method} placeholder="(unchanged)" />
            {@render fieldError('action.method')}
          </label>
        </div>
      {:else}
        <label class="field narrow">
          <span class="label">Status</span>
          <input class="input mono" data-testid="rule-status" bind:value={draft.status} placeholder="(unchanged)" />
          {@render fieldError('action.status')}
        </label>
      {/if}
      <div class="row two">
        <label class="field">
          <span class="label">Set headers <span class="hint">(<code>Name: value</code> per line)</span></span>
          <textarea class="input mono" rows="2" data-testid="rule-set-headers" bind:value={draft.setHeaders}></textarea>
          {@render fieldError('action.setHeaders')}
        </label>
        <label class="field">
          <span class="label">Remove headers <span class="hint">(names, comma separated)</span></span>
          <input class="input mono" data-testid="rule-remove-headers" bind:value={draft.removeHeaders} />
          {@render fieldError('action.removeHeaders')}
        </label>
      </div>
      {@render bodyField()}
      <div class="field">
        <span class="label">Find and replace in the text body <span class="hint">(literal, every occurrence, in order)</span></span>
        {#each draft.replace as row, i (i)}
          <div class="replace-row">
            <input class="input mono" aria-label={`Find ${i + 1}`} bind:value={row.find} placeholder="find" />
            <input class="input mono" aria-label={`Replace ${i + 1}`} bind:value={row.with} placeholder="replace with" />
            <Button variant="ghost" size="sm" onclick={() => draft.removeReplace(i)} aria-label={`Remove replacement ${i + 1}`}>Remove</Button>
          </div>
        {/each}
        <div><Button variant="secondary" size="sm" onclick={() => draft.addReplace()} data-testid="rule-add-replace">Add replacement</Button></div>
        {@render fieldError('action.replace')}
      </div>
      {@render fieldError('action', true)}
    {:else}
      <label class="field narrow">
        <span class="label">Delay (ms, up to 30000)</span>
        <input class="input mono" data-testid="rule-delay" bind:value={draft.delayMs} placeholder="2000" />
        {@render fieldError('action.ms')}
      </label>
    {/if}
  </fieldset>

  <label class="check">
    <input type="checkbox" bind:checked={draft.enabled} />
    <span>Enabled</span>
  </label>

  {#if error}
    <p class="error" role="alert" data-testid="rule-form-error">{error}</p>
  {:else if problem}
    <p class="muted" data-testid="rule-form-problem">{problem.field ? `${problem.field}: ` : ''}{problem.message}</p>
  {/if}

  <div class="actions">
    <Button size="sm" type="submit" disabled={busy || !draft.check.ok} data-testid="rule-save">
      {busy ? 'Saving…' : isNew ? 'Add rule' : 'Save rule'}
    </Button>
    <Button variant="ghost" size="sm" onclick={oncancel} disabled={busy}>Cancel</Button>
  </div>
</form>

{#snippet bodyField()}
  <label class="field">
    <span class="label">Body</span>
    <textarea class="input mono" rows="3" data-testid="rule-body" bind:value={draft.body}></textarea>
    {@render fieldError('action.body')}
    {@render fieldError('action.bodyBase64')}
  </label>
  <label class="check">
    <input type="checkbox" data-testid="rule-body-base64" bind:checked={draft.bodyIsBase64} />
    <span>Body is base64 (binary)</span>
  </label>
{/snippet}

<style>
  .rule-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 10px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
  legend {
    padding: 0 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-primary);
  }
  .row {
    display: grid;
    gap: 10px;
  }
  .row.two {
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  }
  .row.three {
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .field.narrow {
    max-width: 240px;
  }
  .label {
    font-size: 12px;
    color: var(--fg-secondary);
  }
  .hint {
    color: var(--fg-muted);
  }
  code {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .input {
    min-width: 0;
    padding: 6px 8px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-primary);
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }
  textarea.input {
    resize: vertical;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .replace-row {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: 6px;
    align-items: center;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--fg-secondary);
  }
  .field-error,
  .error {
    margin: 0;
    font-size: 11px;
    color: var(--status-error);
    word-break: break-word;
  }
  .error {
    font-size: 12px;
  }
  .muted {
    margin: 0;
    font-size: 12px;
    color: var(--fg-muted);
  }
  .actions {
    display: flex;
    gap: 8px;
  }
</style>
