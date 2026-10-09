<script lang="ts">
  import type { Attachment } from 'svelte/attachments';
  import type { StreamReplayDraft, StreamReplayKey } from '../../lib/state/StreamReplayDraft.svelte.js';
  import { fmtBytes } from '../../lib/format.js';
  import HexEditor from '../../components/HexEditor.svelte';

  // U7 stream replay editor: a modal over the Sockets view for one raw TCP/TLS
  // session (all state in the StreamReplayDraft). The operator picks which
  // client→server frames to send (all by default), may rewrite a frame's bytes in
  // the hex grid, and may change the connection (TLS, SNI, host, port, timeout).
  // Send posts POST /api/replay/stream and hands the new session's key to
  // `onsent`; the editor stays open showing the outcome so the same stream can be
  // tweaked and sent again. Same dialog contract as ReplayEditor: role=dialog +
  // aria-modal, focus moved in and restored, Tab trapped, Escape closes, and no
  // keystroke reaches the App-wide shortcuts while it is open.
  type Props = { draft: StreamReplayDraft; onclose: () => void; onsent: (key: StreamReplayKey) => void };
  let { draft, onclose, onsent }: Props = $props();

  const uid = $props.id();
  const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  let panelEl: HTMLElement | null = null;

  const editingBuffer = $derived(draft.editing == null ? null : (draft.edits.get(draft.editing) ?? null));
  const target = $derived(`${draft.session.kind}://${draft.session.stream?.host ?? '?'}:${draft.session.stream?.port ?? '?'}`);

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
    data-testid="stream-replay-editor"
    onpointerdown={(e) => e.stopPropagation()}
    onkeydown={onKeydown}
    {@attach setup}
  >
    <header class="head">
      <div>
        <h2 id={`${uid}-title`}>Replay stream</h2>
        <p class="sub">{target} · {draft.wsId}</p>
      </div>
      <button type="button" class="close" aria-label="Close" onclick={onclose}>✕</button>
    </header>

    <form class="form" {onsubmit}>
      <fieldset class="group">
        <legend>Connection</legend>
        <div class="line">
          <label class="check">
            <input type="checkbox" bind:checked={draft.tls} />
            TLS
          </label>
          <label class="field grow">
            <span>SNI</span>
            <input type="text" bind:value={draft.sni} disabled={!draft.tls} autocomplete="off" spellcheck="false" />
          </label>
        </div>
        <div class="line">
          <label class="field grow">
            <span>Host</span>
            <input type="text" bind:value={draft.host} autocomplete="off" spellcheck="false" />
          </label>
          <label class="field small">
            <span>Port</span>
            <input type="text" inputmode="numeric" bind:value={draft.port} autocomplete="off" />
          </label>
          <label class="field small">
            <span>Timeout (ms)</span>
            <input type="text" inputmode="numeric" bind:value={draft.timeoutMs} autocomplete="off" />
          </label>
        </div>
        {#if draft.tls}<p class="note">The upstream certificate is verified, as for an HTTP replay.</p>{/if}
      </fieldset>

      <fieldset class="group">
        <legend>Client frames ({draft.selected.size} of {draft.frames.length} selected)</legend>
        {#if draft.loadStatus === 'loading'}
          <p class="note">Loading frames…</p>
        {:else if draft.loadStatus === 'error'}
          <p class="error" role="alert">Could not list this session's frames.</p>
        {:else if draft.frames.length === 0}
          <p class="note">This stream has no client frames: the replay only connects and reads what the server sends.</p>
        {:else}
          <ul class="frames" data-testid="stream-replay-frames">
            {#each draft.frames as f (f.sequence)}
              <li class={['frow', { current: draft.editing === f.sequence }]}>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={draft.selected.has(f.sequence)}
                    onchange={() => draft.toggle(f.sequence)}
                    aria-label={`Send frame #${f.sequence}`}
                  />
                  <span class="seq">#{f.sequence}</span>
                </label>
                <span class="meta">{fmtBytes(f.body.size ?? f.body.storedSize)}{f.binary ? ' · binary' : ''}{f.body.state === 'omitted' ? ` · not retained (${f.body.omitted})` : ''}</span>
                {#if draft.edits.has(f.sequence)}<span class="edited">edited</span>{/if}
                <span class="grow"></span>
                <button type="button" class="ghost bordered" onclick={() => draft.edit(f.sequence)}>Edit bytes</button>
                {#if draft.edits.has(f.sequence)}
                  <button type="button" class="ghost" onclick={() => draft.revert(f.sequence)}>Revert</button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </fieldset>

      {#if editingBuffer && draft.editing != null}
        <fieldset class="group">
          <legend>Frame #{draft.editing} bytes ({editingBuffer.bytes.length} bytes)</legend>
          {#if draft.editError}<p class="error" role="alert">{draft.editError}</p>{/if}
          {#key draft.editing}
            <HexEditor buffer={editingBuffer} label={`frame #${draft.editing}`} />
          {/key}
        </fieldset>
      {/if}

      <footer class="foot">
        <span class="result" role="status">
          {#if draft.phase === 'done' || draft.phase === 'error'}
            <span class={['msg', { err: draft.phase === 'error' }]} data-testid="stream-replay-result">{draft.message}</span>
          {/if}
        </span>
        <button type="button" class="ghost bordered" onclick={onclose}>Close</button>
        <button type="submit" class="send" disabled={draft.phase === 'sending' || draft.loadStatus !== 'done'}>
          {draft.phase === 'sending' ? 'Sending…' : 'Send'}
        </button>
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
  .line {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--fg-muted);
  }
  .field.grow {
    flex: 1 1 auto;
    min-width: 0;
  }
  .field.small {
    flex: 0 0 110px;
  }
  input[type='text'] {
    height: 28px;
    padding: 0 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
  input[type='text']:disabled {
    opacity: 0.5;
  }
  input[type='text']:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 0;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    font-size: 12px;
    color: var(--fg-secondary);
    cursor: pointer;
  }
  .frames {
    display: flex;
    flex-direction: column;
    max-height: 220px;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
  .frow {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding: 0 8px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .frow:last-child {
    border-bottom: none;
  }
  .frow.current {
    box-shadow: inset 2px 0 0 var(--accent);
    background: var(--tint-surface);
  }
  .seq {
    min-width: 40px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-secondary);
  }
  .meta {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
    white-space: nowrap;
  }
  .edited {
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    color: var(--status-4xx);
  }
  .grow {
    flex: 1 1 auto;
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
</style>
