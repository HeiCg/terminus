import { HEX_PAGE_BYTES, HEX_ROW_BYTES, deleteBytes, insertBytes, parseBytes, setByte } from '../bytes.js';

// The editable byte buffer behind the hex editor (U4). All editing is imperative
// (keyboard/click handlers call these methods) and every edit swaps in a NEW
// Uint8Array, so `bytes` is `$state.raw`: no deep proxy over a megabyte of bytes.
//
// `cursor` ranges over 0..length: `length` is the append slot after the last byte.
// Typing a hex digit stores a pending high nibble; the second digit commits the
// byte (overwriting the byte under the cursor, or appending at the end) and moves
// on. `shown` is how many bytes the grid renders; it grows a page at a time, and
// moving the cursor past it grows it, so the cursor is always on screen.
export class HexBuffer {
  bytes = $state.raw<Uint8Array>(new Uint8Array(0));
  cursor = $state(0);
  pending = $state<string | null>(null);
  shown = $state(HEX_PAGE_BYTES);
  error = $state<string | null>(null);

  constructor(bytes: Uint8Array = new Uint8Array(0)) {
    this.bytes = bytes;
  }

  get length(): number { return this.bytes.length; }

  // Replace the whole buffer (text→hex switch, "Replace all" paste).
  replaceAll(bytes: Uint8Array): void {
    this.bytes = bytes;
    this.cursor = Math.min(this.cursor, bytes.length);
    this.pending = null;
    this.error = null;
  }

  moveTo(index: number): void {
    this.pending = null;
    this.cursor = Math.max(0, Math.min(index, this.bytes.length));
    this.#reveal();
  }

  move(delta: number): void { this.moveTo(this.cursor + delta); }

  loadMore(): void { this.shown += HEX_PAGE_BYTES; }

  // Keep the cursor's row rendered: grow `shown` in whole pages past it.
  #reveal(): void {
    while (this.cursor >= this.shown && this.shown < this.bytes.length + HEX_ROW_BYTES) this.shown += HEX_PAGE_BYTES;
  }

  // One typed character. Returns false when it is not a hex digit (the caller
  // lets the key through).
  typeHex(ch: string): boolean {
    if (!/^[0-9a-f]$/i.test(ch)) return false;
    this.error = null;
    if (this.pending == null) { this.pending = ch.toLowerCase(); return true; }
    const value = parseInt(this.pending + ch, 16);
    this.pending = null;
    this.bytes = this.cursor < this.bytes.length
      ? setByte(this.bytes, this.cursor, value)
      : insertBytes(this.bytes, this.cursor, new Uint8Array([value]));
    this.cursor += 1;
    this.#reveal();
    return true;
  }

  cancelPending(): boolean {
    if (this.pending == null) return false;
    this.pending = null;
    return true;
  }

  // Delete the byte under the cursor (the Delete key).
  deleteForward(): void {
    this.pending = null;
    this.bytes = deleteBytes(this.bytes, this.cursor);
    this.cursor = Math.min(this.cursor, this.bytes.length);
  }

  // Delete the byte before the cursor (Backspace).
  deleteBackward(): void {
    if (this.pending != null) { this.pending = null; return; }
    if (this.cursor === 0) return;
    this.bytes = deleteBytes(this.bytes, this.cursor - 1);
    this.cursor -= 1;
  }

  // Insert one byte (default 00) at the cursor, which stays on the new byte.
  insertByte(value = 0): void {
    this.pending = null;
    this.bytes = insertBytes(this.bytes, this.cursor, new Uint8Array([value & 0xff]));
  }

  // Paste hex or base64: inserted at the cursor (cursor moves past it) or
  // replacing everything. Invalid text sets `error` and changes nothing.
  paste(text: string, mode: 'insert' | 'replace' = 'insert', format: 'auto' | 'hex' | 'base64' = 'auto'): boolean {
    const parsed = parseBytes(text, format);
    if (!parsed.ok) { this.error = parsed.error; return false; }
    this.error = null;
    this.pending = null;
    if (mode === 'replace') {
      this.bytes = parsed.bytes;
      this.cursor = 0;
    } else {
      this.bytes = insertBytes(this.bytes, this.cursor, parsed.bytes);
      this.cursor += parsed.bytes.length;
      this.#reveal();
    }
    return true;
  }
}
