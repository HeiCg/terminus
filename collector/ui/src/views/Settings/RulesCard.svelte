<script lang="ts">
  import { RulesEditor, describeRule } from '../../lib/state/RulesEditor.svelte.js';
  import { takeRuleSeed } from '../../lib/state/RuleDraft.svelte.js';
  import Button from '../../components/Button.svelte';
  import RuleForm from './RuleForm.svelte';

  // Interception rules (U6): what the proxy changes on the way through. Loaded once
  // from an attachment on the root, like ScopeCard (it reads no reactive state, so
  // it never re-runs). A request picked in Capture ("Create rule") arrives as a
  // seed and opens a prefilled form once the list is loaded.
  const editor = new RulesEditor();
  let cancelled = false;

  function boot(): () => void {
    const seed = takeRuleSeed();
    editor.load().then(() => {
      if (!cancelled && seed && editor.status === 'ready') editor.startNew(seed);
    });
    return () => { cancelled = true; };
  }
</script>

<section class="surface-card" {@attach boot} aria-label="Interception rules" data-testid="rules-card">
  <div class="head">
    <h2 class="title">Interception rules</h2>
    {#if editor.status === 'ready' && !editor.draft}
      <Button size="sm" onclick={() => editor.startNew()} data-testid="rule-add">Add rule</Button>
    {/if}
  </div>
  <p class="muted">
    Block, mock, rewrite or delay HTTP(S) that goes through the proxy. Rules run top to bottom; the first matching
    block or mock answers the device without contacting the server. They never touch SDK-captured traffic,
    TLS pass-through hosts or the collector itself. Captured entries show which rules ran.
  </p>

  {#if editor.status === 'loading'}
    <p class="muted">Loading…</p>
  {:else if editor.status === 'unavailable'}
    <p class="muted">Rules unavailable.</p>
    <div><Button variant="secondary" size="sm" onclick={() => editor.load()}>Retry</Button></div>
  {:else}
    {#if editor.draft && editor.editIndex == null}
      <RuleForm
        draft={editor.draft}
        isNew
        busy={editor.busy}
        error={editor.formError}
        onsubmit={() => editor.submit()}
        oncancel={() => editor.cancel()}
      />
    {/if}

    {#if editor.rules.length === 0}
      <p class="muted" data-testid="rules-empty">No rules yet.</p>
    {:else}
      <ol class="list" data-testid="rules-list">
        {#each editor.rules as rule, i (rule.id)}
          <li class={['item', { off: !rule.enabled }]} data-testid={`rule-row-${rule.id}`}>
            <label class="toggle" title={rule.enabled ? 'Enabled' : 'Disabled'}>
              <input
                type="checkbox"
                role="switch"
                aria-label={`Enable ${rule.name}`}
                checked={rule.enabled}
                disabled={editor.busy}
                onchange={(e) => editor.toggle(rule.id, e.currentTarget.checked)}
              />
            </label>
            <div class="text">
              <span class="name">{rule.name}</span>
              <span class="desc">{describeRule(rule)}</span>
            </div>
            <div class="row-actions">
              <Button variant="ghost" size="sm" disabled={editor.busy || !!editor.draft || i === 0} onclick={() => editor.move(i, -1)} aria-label={`Move ${rule.name} up`}>↑</Button>
              <Button variant="ghost" size="sm" disabled={editor.busy || !!editor.draft || i === editor.rules.length - 1} onclick={() => editor.move(i, 1)} aria-label={`Move ${rule.name} down`}>↓</Button>
              <Button variant="ghost" size="sm" disabled={editor.busy || !!editor.draft} onclick={() => editor.startEdit(i)} aria-label={`Edit ${rule.name}`}>Edit</Button>
              <Button variant="danger" size="sm" disabled={editor.busy} onclick={() => editor.remove(i)} aria-label={`Delete ${rule.name}`}>Delete</Button>
            </div>
          </li>
          {#if editor.draft && editor.editIndex === i}
            <li class="editing">
              <RuleForm
                draft={editor.draft}
                isNew={false}
                busy={editor.busy}
                error={editor.formError}
                onsubmit={() => editor.submit()}
                oncancel={() => editor.cancel()}
              />
            </li>
          {/if}
        {/each}
      </ol>
    {/if}

    {#if editor.error}
      <p class="error" role="alert" data-testid="rules-error">{editor.error}</p>
    {:else if editor.notice}
      <p class="notice" role="status">{editor.notice}</p>
    {/if}
  {/if}
</section>

<style>
  .surface-card {
    gap: 12px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
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
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .item {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
  .item.off .text {
    opacity: 0.5;
  }
  .toggle input {
    accent-color: var(--accent);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .name {
    font-size: 13px;
    color: var(--fg-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .desc {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-actions {
    display: flex;
    gap: 4px;
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
</style>
