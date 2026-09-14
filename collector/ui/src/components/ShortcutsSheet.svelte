<script lang="ts">
  import type { Attachment } from 'svelte/attachments';
  import { SHORTCUT_GROUPS } from '../lib/shortcuts.js';

  // A modal dialog listing the app's keyboard shortcuts, generated from the single
  // keymap table in `lib/shortcuts.ts`. Same a11y contract as CommandPalette:
  // role="dialog" + aria-modal, focus moved in on open and returned to the opener
  // on close, focus trapped (Tab is contained), and Escape / outside-click close.
  type Props = { onclose: () => void };
  let { onclose }: Props = $props();

  // The element focused when the sheet opened, captured at init (before the panel's
  // focus attachment runs) so close hands focus back — matches CommandPalette.
  const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

  function onKeydown(e: KeyboardEvent): void {
    // Own Escape while open so the App-root Escape handler never also runs (which
    // would clear the table selection).
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onclose();
      return;
    }
    // Trap focus: the only focusable control is the Close button, so keep Tab here.
    if (e.key === 'Tab') e.preventDefault();
  }

  const focusPanel: Attachment = (node) => { (node as HTMLElement).focus(); };

  // On teardown, restore focus to the opener, falling back to the search box —
  // the same fallback CommandPalette uses.
  const restoreFocus: Attachment = () => () => {
    const back = opener && opener !== document.body && document.contains(opener)
      ? opener
      : document.querySelector<HTMLElement>('[data-testid="search"]');
    back?.focus();
  };
</script>

<div class="backdrop" role="presentation" onpointerdown={onclose} {@attach restoreFocus}>
  <div
    class="panel"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Keyboard shortcuts"
    data-testid="shortcuts-sheet"
    onpointerdown={(e) => e.stopPropagation()}
    onkeydown={onKeydown}
    {@attach focusPanel}
  >
    <header class="head">
      <h2>Keyboard shortcuts</h2>
      <button type="button" class="close" aria-label="Close" onclick={onclose}>✕</button>
    </header>
    <div class="groups">
      {#each SHORTCUT_GROUPS as group (group.title)}
        <section class="grp">
          <h3>{group.title}</h3>
          <dl>
            {#each group.items as item (item.label)}
              <div class="row">
                <dt><kbd>{item.keys}</kbd></dt>
                <dd>{item.label}</dd>
              </div>
            {/each}
          </dl>
        </section>
      {/each}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    background: color-mix(in srgb, var(--bg-base) 60%, transparent);
  }
  .panel {
    width: 460px;
    max-width: 92vw;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .panel:focus {
    outline: none;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .head h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg-primary);
  }
  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    font-size: 12px;
    color: var(--fg-muted);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .close:hover {
    color: var(--fg-primary);
    background: var(--bg-surface);
  }
  .groups {
    padding: 8px 16px 16px;
    overflow-y: auto;
  }
  .grp h3 {
    margin: 12px 0 4px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }
  dl {
    margin: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 5px 0;
  }
  dt {
    flex: 0 0 120px;
  }
  dd {
    margin: 0;
    font-size: 12px;
    color: var(--fg-secondary);
  }
  kbd {
    display: inline-block;
    padding: 2px 7px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-primary);
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
</style>
