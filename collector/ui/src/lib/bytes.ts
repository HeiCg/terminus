// Pure byte helpers for the hex viewer/editor and the replay editor (U4). Bodies
// travel through the UI as strings — UTF-8 text, or base64 for a binary body (the
// BodyCache contract) — so everything here converts between those and real bytes,
// formats hex dump rows on demand, and parses user-typed hex or base64. No DOM,
// no reactivity: table-testable and cheap to call from a `$derived`.

export const HEX_ROW_BYTES = 16;
// Bytes rendered per "page" of a hex dump; more are rendered only on request, so
// a 1 MiB body never builds 65 536 rows up front.
export const HEX_PAGE_BYTES = 4096;

const UTF8 = new TextEncoder();
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

export const utf8Encode = (s: string): Uint8Array => UTF8.encode(s);

// The text of `bytes` when they are valid UTF-8, else null.
export function utf8DecodeStrict(bytes: Uint8Array): string | null {
  try { return STRICT_UTF8.decode(bytes); } catch { return null; }
}

// Base64 of raw bytes, chunked so a large body never overflows the call stack.
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

// Strict standard base64 (whitespace ignored, padding optional) to bytes; null
// when the text is not base64. Backed by a plain ArrayBuffer (a valid BlobPart).
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  const t = b64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t) || t.length % 4 === 1) return null;
  const padded = t.length % 4 === 0 ? t : t + '='.repeat(4 - (t.length % 4));
  let bin: string;
  try { bin = atob(padded); } catch { return null; }
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export const hexByte = (b: number): string => HEX[b & 0xff];

// Space-separated lowercase hex of all bytes (the "Copy as hex" text).
export function bytesToHex(bytes: Uint8Array, sep = ' '): string {
  const parts = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) parts[i] = HEX[bytes[i]];
  return parts.join(sep);
}

// The printable-ASCII rendering of one byte; anything else is a dot.
export const asciiChar = (b: number): string => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');

export const fmtOffset = (n: number): string => n.toString(16).padStart(8, '0');

export type HexRow = { offset: number; label: string; hex: string; ascii: string };

// The dump rows covering bytes [start, end): offset label, the 16 hex pairs (a
// short last row padded so the ASCII column stays aligned) and the ASCII column.
export function hexRows(bytes: Uint8Array, start: number, end: number): HexRow[] {
  const rows: HexRow[] = [];
  const stop = Math.min(end, bytes.length);
  for (let off = Math.max(0, start); off < stop; off += HEX_ROW_BYTES) {
    const slice = bytes.subarray(off, Math.min(off + HEX_ROW_BYTES, stop));
    let hex = '';
    let ascii = '';
    for (let i = 0; i < HEX_ROW_BYTES; i++) {
      if (i > 0) hex += i === 8 ? '  ' : ' ';
      if (i < slice.length) { hex += HEX[slice[i]]; ascii += asciiChar(slice[i]); } else hex += '  ';
    }
    rows.push({ offset: off, label: fmtOffset(off), hex, ascii });
  }
  return rows;
}

export type ParsedBytes = { ok: true; bytes: Uint8Array; format: 'hex' | 'base64' } | { ok: false; error: string };

// Parse pasted text as bytes. Hex accepts pairs with optional `0x` prefixes and
// whitespace, `:`, `-` or `,` separators; base64 is the standard alphabet. In
// `auto` mode text that reads as hex wins (`deadbeef` is valid in both). Empty
// input is an error, so a stray paste never silently clears a body.
export function parseBytes(input: string, format: 'auto' | 'hex' | 'base64' = 'auto'): ParsedBytes {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Nothing to parse' };
  if (format !== 'base64') {
    const hex = text.replace(/0x/gi, '').replace(/[\s:,-]+/g, '');
    if (/^[0-9a-f]*$/i.test(hex)) {
      if (hex.length % 2 === 0) {
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return { ok: true, bytes: out, format: 'hex' };
      }
      if (format === 'hex') return { ok: false, error: 'Hex needs an even number of digits' };
    } else if (format === 'hex') {
      return { ok: false, error: 'Not hex: use digits 0-9 and a-f' };
    }
  }
  const b64 = base64ToBytes(text);
  if (b64) return { ok: true, bytes: b64, format: 'base64' };
  return { ok: false, error: format === 'base64' ? 'Not valid base64' : 'Not valid hex or base64' };
}

// Immutable edits: each returns a NEW array (the editor state is `$state.raw`).
export function setByte(bytes: Uint8Array, index: number, value: number): Uint8Array {
  const out = bytes.slice();
  out[index] = value & 0xff;
  return out;
}

export function insertBytes(bytes: Uint8Array, index: number, ins: Uint8Array): Uint8Array {
  const at = Math.max(0, Math.min(index, bytes.length));
  const out = new Uint8Array(bytes.length + ins.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(ins, at);
  out.set(bytes.subarray(at), at + ins.length);
  return out;
}

export function deleteBytes(bytes: Uint8Array, index: number, count = 1): Uint8Array {
  if (index < 0 || index >= bytes.length || count <= 0) return bytes;
  const end = Math.min(bytes.length, index + count);
  const out = new Uint8Array(bytes.length - (end - index));
  out.set(bytes.subarray(0, index), 0);
  out.set(bytes.subarray(end), index);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
