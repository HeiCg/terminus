import { describe, it, expect } from 'vitest';
import {
  bytesToBase64, base64ToBytes, bytesToHex, hexRows, parseBytes, setByte, insertBytes, deleteBytes,
  utf8DecodeStrict, utf8Encode, bytesEqual, fmtOffset,
} from '../bytes.js';

const b = (...xs: number[]) => new Uint8Array(xs);

describe('base64 round trip', () => {
  it('encodes and decodes every byte value', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(Array.from(base64ToBytes(bytesToBase64(all))!)).toEqual(Array.from(all));
  });
  it('accepts missing padding and whitespace, rejects junk', () => {
    expect(Array.from(base64ToBytes('AAEC/w')!)).toEqual([0, 1, 2, 255]);
    expect(Array.from(base64ToBytes('AAEC\n/w==')!)).toEqual([0, 1, 2, 255]);
    expect(base64ToBytes('not base64!')).toBeNull();
    expect(base64ToBytes('A')).toBeNull();
  });
});

describe('hexRows', () => {
  it('renders offsets, 16 hex pairs per row and the ASCII column', () => {
    const bytes = new Uint8Array(20).map((_, i) => 0x41 + i);
    const rows = hexRows(bytes, 0, bytes.length);
    expect(rows).toHaveLength(2);
    expect(rows[0].label).toBe('00000000');
    expect(rows[0].hex).toBe('41 42 43 44 45 46 47 48  49 4a 4b 4c 4d 4e 4f 50');
    expect(rows[0].ascii).toBe('ABCDEFGHIJKLMNOP');
    expect(rows[1].label).toBe('00000010');
    expect(rows[1].hex.startsWith('51 52 53 54 ')).toBe(true);
    expect(rows[1].hex).toHaveLength(rows[0].hex.length); // padded short row
    expect(rows[1].ascii).toBe('QRST');
  });
  it('renders non-printables as dots and honours the [start, end) window', () => {
    const bytes = new Uint8Array(64);
    bytes[32] = 0x7f;
    const rows = hexRows(bytes, 32, 48);
    expect(rows).toHaveLength(1);
    expect(rows[0].offset).toBe(32);
    expect(rows[0].ascii).toBe('.'.repeat(16));
  });
  it('fmtOffset pads to 8 hex digits', () => {
    expect(fmtOffset(0x1000)).toBe('00001000');
  });
});

describe('parseBytes', () => {
  it('parses hex with separators and 0x prefixes', () => {
    const r = parseBytes('0xde 0xad:be-ef,00');
    expect(r).toEqual({ ok: true, bytes: b(0xde, 0xad, 0xbe, 0xef, 0x00), format: 'hex' });
  });
  it('prefers hex for text valid in both, base64 otherwise', () => {
    expect(parseBytes('deadbeef')).toMatchObject({ ok: true, format: 'hex' });
    const r = parseBytes('AAEC/w==');
    expect(r.ok && Array.from(r.bytes)).toEqual([0, 1, 2, 255]);
    expect(r).toMatchObject({ format: 'base64' });
  });
  it('honours an explicit format', () => {
    const r = parseBytes('deadbeef', 'base64');
    expect(r).toMatchObject({ ok: true, format: 'base64' });
    expect(parseBytes('abc', 'hex')).toEqual({ ok: false, error: 'Hex needs an even number of digits' });
    expect(parseBytes('zz', 'hex')).toEqual({ ok: false, error: 'Not hex: use digits 0-9 and a-f' });
  });
  it('rejects empty and invalid input', () => {
    expect(parseBytes('   ')).toEqual({ ok: false, error: 'Nothing to parse' });
    expect(parseBytes('hello world!')).toEqual({ ok: false, error: 'Not valid hex or base64' });
  });
});

describe('edits', () => {
  it('setByte, insertBytes and deleteBytes return new arrays with the right bytes', () => {
    const src = b(1, 2, 3);
    expect(Array.from(setByte(src, 1, 0xff))).toEqual([1, 0xff, 3]);
    expect(Array.from(insertBytes(src, 1, b(9, 9)))).toEqual([1, 9, 9, 2, 3]);
    expect(Array.from(insertBytes(src, 3, b(4)))).toEqual([1, 2, 3, 4]);
    expect(Array.from(deleteBytes(src, 0))).toEqual([2, 3]);
    expect(Array.from(deleteBytes(src, 1, 5))).toEqual([1]);
    expect(deleteBytes(src, 3)).toBe(src); // out of range: unchanged
    expect(Array.from(src)).toEqual([1, 2, 3]); // the source is never mutated
  });
  it('bytesToHex and bytesEqual', () => {
    expect(bytesToHex(b(0, 15, 255))).toBe('00 0f ff');
    expect(bytesEqual(b(1, 2), b(1, 2))).toBe(true);
    expect(bytesEqual(b(1, 2), b(1, 3))).toBe(false);
  });
  it('utf8DecodeStrict accepts text and refuses invalid sequences', () => {
    expect(utf8DecodeStrict(utf8Encode('héllo'))).toBe('héllo');
    expect(utf8DecodeStrict(b(0xff, 0xfe))).toBeNull();
  });
});
