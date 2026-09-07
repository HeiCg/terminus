import { describe, it, expect } from 'vitest';
import { encodeQr } from '../qr.js';

// A finder pattern is a 7×7 block: a dark border ring, a light ring, and a dark
// 3×3 core — i.e. dark exactly where the Chebyshev distance from the block centre
// is not 2. Checking the three corners proves the matrix is a real QR frame, not
// just a square of the right size.
function isFinder(matrix: boolean[][], ox: number, oy: number): boolean {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (matrix[oy + dy][ox + dx] !== (dist !== 2)) return false;
    }
  }
  return true;
}

function square(matrix: boolean[][]): number {
  expect(Array.isArray(matrix)).toBe(true);
  const n = matrix.length;
  for (const row of matrix) expect(row.length).toBe(n);
  return n;
}

describe('encodeQr', () => {
  it('encodes "HELLO WORLD" as a small odd matrix with three finder patterns', () => {
    const m = encodeQr('HELLO WORLD');
    const n = square(m);
    expect([21, 25]).toContain(n);
    expect(isFinder(m, 0, 0)).toBe(true); // top-left
    expect(isFinder(m, n - 7, 0)).toBe(true); // top-right
    expect(isFinder(m, 0, n - 7)).toBe(true); // bottom-left
  });

  it('encodes a ~180-char JSON as a valid odd matrix of side ≥ 45', () => {
    const payload = JSON.stringify({
      v: 2,
      host: '192.168.1.42',
      ingestPort: 8443,
      atlantisPort: 8444,
      certificateSha256: 'a'.repeat(64),
      deviceToken: 'b'.repeat(43),
    });
    expect(payload.length).toBeGreaterThanOrEqual(150);
    const m = encodeQr(payload);
    const n = square(m);
    expect(n % 2).toBe(1); // QR side is always odd (4·version + 17)
    expect(n).toBeGreaterThanOrEqual(45);
    expect(isFinder(m, 0, 0)).toBe(true);
    expect(isFinder(m, n - 7, 0)).toBe(true);
    expect(isFinder(m, 0, n - 7)).toBe(true);
  });

  it('is deterministic for the same input', () => {
    expect(encodeQr('HELLO WORLD')).toEqual(encodeQr('HELLO WORLD'));
  });

  it('encodes a ~341-byte QrPairing (63-char host) as a valid version-14 frame', () => {
    // The largest QrPairing the pairing card must render: a full 63-char DNS label.
    // One byte past v13 capacity, so this exercises the v14 EC/alignment tables.
    const payload = JSON.stringify({
      version: 2,
      collectorId: '6f1c2b0e-3b7a-4c1d-9e2f-0a1b2c3d4e5f',
      host: 'a'.repeat(63),
      certPort: 8789,
      ingestPort: 8788,
      atlantisPort: 10909,
      certificateSha256: '0'.repeat(64),
      deviceToken: 'A'.repeat(43),
    });
    expect(payload.length).toBeGreaterThan(331); // beyond v13
    const m = encodeQr(payload);
    const n = square(m);
    expect(n).toBe(4 * 14 + 17); // version 14 → 73×73
    expect(isFinder(m, 0, 0)).toBe(true);
    expect(isFinder(m, n - 7, 0)).toBe(true);
    expect(isFinder(m, 0, n - 7)).toBe(true);
  });

  it('throws only past version-14 capacity', () => {
    expect(() => encodeQr('x'.repeat(362))).not.toThrow(); // v14 holds 362 bytes
    expect(() => encodeQr('x'.repeat(363))).toThrow(/too large/);
  });
});
