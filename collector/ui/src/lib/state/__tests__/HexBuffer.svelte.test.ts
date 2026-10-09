import { describe, it, expect } from 'vitest';
import { HexBuffer } from '../HexBuffer.svelte.js';
import { HEX_PAGE_BYTES } from '../../bytes.js';

const arr = (h: HexBuffer) => Array.from(h.bytes);

describe('HexBuffer edits', () => {
  it('two hex digits overwrite the byte under the cursor and advance', () => {
    const h = new HexBuffer(new Uint8Array([1, 2, 3]));
    h.moveTo(1);
    expect(h.typeHex('f')).toBe(true);
    expect(h.pending).toBe('f');
    expect(arr(h)).toEqual([1, 2, 3]); // nothing committed on the first nibble
    h.typeHex('E');
    expect(arr(h)).toEqual([1, 0xfe, 3]);
    expect(h.cursor).toBe(2);
    expect(h.pending).toBeNull();
  });

  it('typing at the end appends', () => {
    const h = new HexBuffer(new Uint8Array([1]));
    h.moveTo(1);
    h.typeHex('0'); h.typeHex('a');
    expect(arr(h)).toEqual([1, 0x0a]);
    expect(h.cursor).toBe(2);
  });

  it('a non-hex key is refused and changes nothing', () => {
    const h = new HexBuffer(new Uint8Array([1]));
    expect(h.typeHex('g')).toBe(false);
    expect(h.pending).toBeNull();
  });

  it('insert, delete forward and backspace', () => {
    const h = new HexBuffer(new Uint8Array([1, 2, 3]));
    h.moveTo(1);
    h.insertByte();
    expect(arr(h)).toEqual([1, 0, 2, 3]);
    h.deleteForward();
    expect(arr(h)).toEqual([1, 2, 3]);
    h.moveTo(3);
    h.deleteBackward();
    expect(arr(h)).toEqual([1, 2]);
    expect(h.cursor).toBe(2);
    h.moveTo(0);
    h.deleteBackward(); // at the start: no-op
    expect(arr(h)).toEqual([1, 2]);
  });

  it('backspace first drops a pending nibble', () => {
    const h = new HexBuffer(new Uint8Array([1, 2]));
    h.moveTo(1);
    h.typeHex('a');
    h.deleteBackward();
    expect(h.pending).toBeNull();
    expect(arr(h)).toEqual([1, 2]);
  });

  it('pastes hex or base64 at the cursor, or replaces all', () => {
    const h = new HexBuffer(new Uint8Array([1, 2]));
    h.moveTo(1);
    expect(h.paste('aa bb')).toBe(true);
    expect(arr(h)).toEqual([1, 0xaa, 0xbb, 2]);
    expect(h.cursor).toBe(3);
    expect(h.paste('AAEC/w==', 'replace')).toBe(true);
    expect(arr(h)).toEqual([0, 1, 2, 255]);
    expect(h.cursor).toBe(0);
  });

  it('an invalid paste sets an error and keeps the bytes', () => {
    const h = new HexBuffer(new Uint8Array([1]));
    expect(h.paste('not hex!')).toBe(false);
    expect(h.error).toBe('Not valid hex or base64');
    expect(arr(h)).toEqual([1]);
    h.typeHex('0'); // the next edit clears the error
    expect(h.error).toBeNull();
  });

  it('moving the cursor past the rendered pages grows them', () => {
    const h = new HexBuffer(new Uint8Array(HEX_PAGE_BYTES * 3));
    expect(h.shown).toBe(HEX_PAGE_BYTES);
    h.moveTo(HEX_PAGE_BYTES + 5);
    expect(h.shown).toBe(HEX_PAGE_BYTES * 2);
    h.move(-10_000_000);
    expect(h.cursor).toBe(0);
    h.move(10_000_000);
    expect(h.cursor).toBe(HEX_PAGE_BYTES * 3);
  });
});
