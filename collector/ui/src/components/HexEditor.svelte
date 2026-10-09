<script lang="ts">
  import type { HexBuffer } from '../lib/state/HexBuffer.svelte.js';
  import { HEX_ROW_BYTES, hexByte, asciiChar, fmtOffset } from '../lib/bytes.js';

  // Editable hex grid (U4), used by the replay editor for a binary request body.
  // The grid is ONE focus stop (role="grid", aria-activedescendant names the byte
  // under the cursor): arrows / PageUp / PageDown / Home / End move, two hex
  // digits overwrite (or append at the end slot), Delete / Backspace remove,
  // Insert adds a 00 byte, Escape drops a half-typed digit, and a paste (Cmd+V
  // into the grid, or the box below) inserts hex or base64 at the cursor. All
  // state lives in the HexBuffer; this component only renders and dispatches.
  // Like HexView it renders only the bytes the buffer says are shown (4 KiB pages).
  type Props = { buffer: HexBuffer; label?: string };
  let { buffer, label = 'request body' }: Props = $props();

  const uid = $props.id();
  let pasteText = $state('');
  let gridEl: HTMLElement | null = null;

  // Cells rendered: the shown bytes plus the append slot when it is in range.
  const cellCount = $derived(Math.min(buffer.shown, buffer.bytes.length + 1));
  const rowOffsets = $derived.by((): number[] => {
    const out: number[] = [];
    for (let off = 0; off < cellCount; off += HEX_ROW_BYTES) out.push(off);
    return out;
  });
  const remaining = $derived(Math.max(0, buffer.bytes.length + 1 - buffer.shown));
  const cellId = (i: number): string => `${uid}-b${i}`;

  function scrollToCursor(): void {
    const id = cellId(buffer.cursor);
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView?.({ block: 'nearest' }));
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // copy/paste shortcuts pass through
    const rowStart = buffer.cursor - (buffer.cursor % HEX_ROW_BYTES);
    switch (e.key) {
      case 'ArrowLeft': buffer.move(-1); break;
      case 'ArrowRight': buffer.move(1); break;
      case 'ArrowUp': buffer.move(-HEX_ROW_BYTES); break;
      case 'ArrowDown': buffer.move(HEX_ROW_BYTES); break;
      case 'PageUp': buffer.move(-HEX_ROW_BYTES * 16); break;
      case 'PageDown': buffer.move(HEX_ROW_BYTES * 16); break;
      case 'Home': buffer.moveTo(rowStart); break;
      case 'End': buffer.moveTo(Math.min(rowStart + HEX_ROW_BYTES - 1, buffer.bytes.length)); break;
      case 'Delete': buffer.deleteForward(); break;
      case 'Backspace': buffer.deleteBackward(); break;
      case 'Insert': buffer.insertByte(); break;
      case 'Escape':
        // Only consume Escape when it cancels a half-typed byte; otherwise the
        // surrounding dialog gets it (and closes).
        if (!buffer.cancelPending()) return;
        e.stopPropagation();
        break;
      default:
        if (e.key.length !== 1 || !buffer.typeHex(e.key)) return;
    }
    e.preventDefault();
    scrollToCursor();
  }

  function onclick(e: MouseEvent): void {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
    if (cell) buffer.moveTo(Number(cell.dataset.index));
  }

  function onpaste(e: ClipboardEvent): void {
    const text = e.clipboardData?.getData('text') ?? '';
    e.preventDefault();
    buffer.paste(text, 'insert');
  }

  function applyPaste(mode: 'insert' | 'replace'): void {
    if (buffer.paste(pasteText, mode)) pasteText = '';
    gridEl?.focus();
  }

  function cellText(i: number): string {
    if (i === buffer.cursor && buffer.pending != null) return `${buffer.pending}_`;
    return i < buffer.bytes.length ? hexByte(buffer.bytes[i]) : '··';
  }

  function asciiOf(off: number): string {
    let s = '';
    const end = Math.min(off + HEX_ROW_BYTES, buffer.bytes.length);
    for (let i = off; i < end; i++) s += asciiChar(buffer.bytes[i]);
    return s;
  }
</script>

<div class="hexeditor" data-testid="hex-editor">
  <div class="bar">
    <span class="count" data-testid="hex-editor-count">{buffer.bytes.length} bytes</span>
    <span class="pos">cursor {fmtOffset(buffer.cursor)}</span>
    <button type="button" class="ghost" onclick={() => { buffer.insertByte(); gridEl?.focus(); }}>Insert byte</button>
    <button
      type="button"
      class="ghost"
      disabled={buffer.cursor >= buffer.bytes.length}
      onclick={() => { buffer.deleteForward(); gridEl?.focus(); }}
    >Delete byte</button>
  </div>

  <div
    class="grid"
    role="grid"
    tabindex="0"
    aria-label={`Hex editor for the ${label}. Type hex digits to edit, arrows to move, Insert, Delete or Backspace to add or remove bytes.`}
    aria-activedescendant={cellId(buffer.cursor)}
    data-testid="hex-grid"
    {onkeydown}
    {onclick}
    {onpaste}
    {@attach (node) => { gridEl = node; return () => { gridEl = null; }; }}
  >
    {#each rowOffsets as off (off)}
      <div class="row" role="row">
        <span class="off" role="rowheader">{fmtOffset(off)}</span>
        {#each { length: Math.min(HEX_ROW_BYTES, cellCount - off) }, j (j)}
          {@const i = off + j}
          <span
            id={cellId(i)}
            role="gridcell"
            class={['cell', { cursor: i === buffer.cursor, slot: i === buffer.bytes.length, gap: j === 8 }]}
            aria-selected={i === buffer.cursor}
            aria-label={i < buffer.bytes.length ? `offset ${i}: ${hexByte(buffer.bytes[i])}` : 'end of body: type to append'}
            data-index={i}
          >{cellText(i)}</span>
        {/each}
        <span class="ascii" aria-hidden="true">{asciiOf(off)}</span>
      </div>
    {/each}
  </div>
  {#if remaining > 0}
    <div class="more">
      <button type="button" class="ghost bordered" onclick={() => buffer.loadMore()}>Show more bytes</button>
    </div>
  {/if}

  <div class="paste">
    <input
      type="text"
      class="paste-input"
      placeholder="Paste hex (de ad be ef) or base64"
      aria-label="Hex or base64 to paste"
      bind:value={pasteText}
      onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyPaste('insert'); } }}
    />
    <button type="button" class="ghost bordered" disabled={!pasteText.trim()} onclick={() => applyPaste('insert')}>Insert at cursor</button>
    <button type="button" class="ghost bordered" disabled={!pasteText.trim()} onclick={() => applyPaste('replace')}>Replace all</button>
  </div>
  {#if buffer.error}<p class="error" role="alert">{buffer.error}</p>{/if}
</div>

<style>
  .hexeditor {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .count {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-primary);
  }
  .pos {
    margin-right: auto;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .ghost {
    height: 24px;
    padding: 0 8px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .ghost:hover:not(:disabled) {
    color: var(--fg-primary);
    background: var(--bg-elevated);
  }
  .ghost:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .ghost.bordered {
    border: 1px solid var(--border-subtle);
  }
  .grid {
    max-height: 280px;
    overflow: auto;
    padding: 6px 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 20px;
    background: var(--bg-base);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    cursor: text;
  }
  .grid:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .row {
    display: flex;
    align-items: center;
    white-space: pre;
  }
  .off {
    flex: 0 0 auto;
    width: 9ch;
    color: var(--fg-muted);
  }
  .cell {
    flex: 0 0 auto;
    width: 3ch;
    text-align: center;
    color: var(--fg-primary);
    border-radius: 2px;
  }
  .cell.gap {
    margin-left: 1ch;
  }
  .cell.slot {
    color: var(--fg-muted);
  }
  .cell.cursor {
    color: var(--fg-on-accent);
    background: var(--accent);
  }
  .ascii {
    flex: 0 0 auto;
    margin-left: 2ch;
    color: var(--fg-secondary);
  }
  .more {
    display: flex;
  }
  .paste {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .paste-input {
    flex: 1 1 auto;
    min-width: 0;
    height: 26px;
    padding: 0 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
  .error {
    margin: 0;
    font-size: 12px;
    color: var(--status-error);
  }
</style>
