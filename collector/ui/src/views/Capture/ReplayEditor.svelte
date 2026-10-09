<script lang="ts">
  import type { Attachment } from 'svelte/attachments';
  import type { ReplayDraft, ReplayKey } from '../../lib/state/ReplayDraft.svelte.js';
  import { fmtBytes } from '../../lib/format.js';
  import Segmented from '../../components/Segmented.svelte';
  import HexEditor from '../../components/HexEditor.svelte';

  // U4 replay editor: a modal over the Capture view, prefilled from the captured
  // request (all state in the ReplayDraft). Method, URL, header rows and the body
  // (text, or a hex grid for bytes) are editable; Send posts only what changed
  // and hands the new entry's key to `onsent`, which navigates to it. The editor
  // stays open showing the outcome, so the same request can be tweaked and sent
  // again. Credentials are stripped unless opted into, and that opt-in needs a
  // confirming second Send. Same dialog contract as ShortcutsSheet: role=dialog
  // + aria-modal, focus moved in and restored, Tab trapped, Escape closes, and
  // keystrokes never reach the App-wide shortcuts while it is open.
  type Props = { draft: ReplayDraft; onclose: () => void; onsent: (key: ReplayKey) => void };
  let { draft, onclose, onsent }: Props = $props();

  const uid = $props.id();
  const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  let panelEl: HTMLElement | null = null;

  const BODY_MODES = [
    { id: 'text', label: 'Text' },
    { id: 'hex', label: 'Hex' },
  ];

  const bodyless = $derived(['GET', 'HEAD'].includes(draft.method.trim().toUpperCase()));
  const unavailable = $derived(draft.original.body.kind === 'unavailable' ? draft.original.body.reason : null);
  const sendLabel = $derived(draft.phase === 'sending' ? 'Sending…' : draft.armed ? 'Send with credentials' : 'Send');

  const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]';

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    } else if (e.key === 'Tab' && panelEl) {
      const items = [...panelEl.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length) {
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    // Modal: no keystroke reaches the App-wide j/k/`/` shortcuts.
    e.stopPropagation();
  }

  async function onsubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const key = await draft.send();
    if (key) onsent(key);
  }

  const setup: Attachment = (node) => {
    panelEl = node as HTMLElement;
    panelEl.querySelector<HTMLElement>('input')?.focus();
    return () => {
      panelEl = null;
      if (opener && opener !== document.body && document.contains(opener)) opener.focus();
    };
  };
</script>

<div class="backdrop" role="presentation" onpointerdown={onclose}>
  <div
    class="panel"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby={`${uid}-title`}
    data-testid="replay-editor"
    onpointerdown={(e) => e.stopPropagation()}
    onkeydown={onKeydown}
    {@attach setup}
  >
    <header class="head">
      <div>
        <h2 id={`${uid}-title`}>Edit and replay</h2>
        <p class="sub">{draft.original.method} {draft.original.url}</p>
      </div>
      <button type="button" class="close" aria-label="Close" onclick={onclose}>✕</button>
    </header>

    <form class="form" {onsubmit}>
      <div class="line">
        <label class="field method">
          <span>Method</span>
          <input type="text" bind:value={draft.method} autocomplete="off" spellcheck="false" />
        </label>
        <label class="field url">
          <span>URL</span>
          <input type="text" bind:value={draft.url} autocomplete="off" spellcheck="false" />
        </label>
      </div>

      <fieldset class="group">
        <legend>Headers</legend>
        {#if draft.headers.length === 0}<p class="note">No headers.</p>{/if}
        {#each draft.headers as h, i (h.key)}
          <div class="hrow">
            <input type="text" class="hname" aria-label={`Header ${i + 1} name`} bind:value={h.name} spellcheck="false" />
            <input type="text" class="hvalue" aria-label={`Header ${i + 1} value`} bind:value={h.value} spellcheck="false" />
            <button
              type="button"
              class="ghost"
              aria-label={`Remove header ${h.name || i + 1}`}
              onclick={() => draft.removeHeader(h.key)}
            >Remove</button>
          </div>
        {/each}
        <button type="button" class="ghost bordered" onclick={() => draft.addHeader()}>Add header</button>
      </fieldset>

      <fieldset class="group">
        <legend>Body</legend>
        <div class="bodybar">
          <Segmented options={BODY_MODES} value={draft.bodyMode} onchange={(m) => draft.setBodyMode(m as 'text' | 'hex')} />
          <span class="count" data-testid="replay-byte-count">{draft.byteCount} bytes · {fmtBytes(draft.byteCount)}</span>
        </div>
        {#if draft.modeError}<p class="error" role="alert">{draft.modeError}</p>{/if}
        {#if unavailable}
          <p class="note">The captured body was not retained ({unavailable}). Enter a body to send one; without it the collector refuses the replay.</p>
        {/if}
        {#if bodyless}<p class="note">{draft.method.trim().toUpperCase()} requests are sent without a body.</p>{/if}
        {#if draft.bodyMode === 'text'}
          <textarea class="text" aria-label="Request body text" bind:value={draft.text} spellcheck="false" rows="8"></textarea>
        {:else}
          <HexEditor buffer={draft.hex} />
        {/if}
      </fieldset>

      <footer class="foot">
        <label class="creds" title="Re-send the authorization/cookie headers and token query params that were captured">
          <input type="checkbox" checked={draft.withCreds} onchange={(e) => draft.setWithCreds(e.currentTarget.checked)} />
          Include captured credentials
        </label>
        <span class="result" role="status">
          {#if draft.phase === 'done' || draft.phase === 'error'}
            <span class={['msg', { err: draft.phase === 'error' }]}>{draft.message}</span>
          {/if}
          {#if draft.phase === 'done' && draft.stripped.length}<span class="msg">stripped: {draft.stripped.join(', ')}</span>{/if}
        </span>
        <button type="button" class="ghost bordered" onclick={onclose}>Close</button>
        <button type="submit" class={['send', { armed: draft.armed }]} disabled={draft.phase === 'sending'}>{sendLabel}</button>
      </footer>
    </form>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 6vh;
    background: color-mix(in srgb, var(--bg-base) 70%, transparent);
  }
  .panel {
    width: min(760px, 94vw);
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    outline: none;
  }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle);
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--fg-primary);
  }
  .sub {
    margin: 4px 0 0;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
    word-break: break-all;
  }
  .close {
    width: 24px;
    height: 24px;
    color: var(--fg-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .close:hover {
    color: var(--fg-primary);
    background: var(--bg-elevated);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    padding: 12px 16px;
    overflow: auto;
  }
  .line {
    display: flex;
    gap: 8px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--fg-muted);
  }
  .field.method {
    flex: 0 0 110px;
  }
  .field.url {
    flex: 1 1 auto;
    min-width: 0;
  }
  input[type='text'],
  textarea {
    height: 28px;
    padding: 0 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
  textarea {
    height: auto;
    min-height: 120px;
    padding: 6px 8px;
    resize: vertical;
  }
  input[type='text']:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 0;
  }
  .group {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    margin: 0;
    padding: 0;
    border: none;
  }
  legend {
    margin-bottom: 6px;
    padding: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-secondary);
  }
  .hrow {
    display: flex;
    gap: 6px;
  }
  .hname {
    flex: 0 0 34%;
    min-width: 0;
  }
  .hvalue {
    flex: 1 1 auto;
    min-width: 0;
  }
  .group > .ghost {
    align-self: flex-start;
  }
  .bodybar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .count {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .note {
    margin: 0;
    font-size: 11px;
    color: var(--fg-muted);
  }
  .error {
    margin: 0;
    font-size: 12px;
    color: var(--status-error);
  }
  .ghost {
    height: 26px;
    padding: 0 8px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .ghost:hover {
    color: var(--fg-primary);
    background: var(--bg-elevated);
  }
  .ghost.bordered {
    border: 1px solid var(--border-subtle);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding-top: 8px;
    border-top: 1px solid var(--border-subtle);
  }
  .creds {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .result {
    flex: 1 1 auto;
    display: inline-flex;
    gap: 8px;
    min-width: 0;
  }
  .msg {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .msg.err {
    color: var(--status-error);
  }
  .send {
    height: 28px;
    padding: 0 14px;
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-on-accent);
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .send:disabled {
    opacity: 0.7;
    cursor: default;
  }
  .send.armed {
    background: var(--status-error);
    border-color: var(--status-error);
  }
</style>
