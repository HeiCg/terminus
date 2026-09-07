// A minimal, dependency-free QR encoder: byte mode, error-correction level M,
// versions 1–14 auto-selected, mask chosen by the standard penalty score. It
// exists so the pairing card can render a scannable code inline (no runtime dep,
// no network) — the payload is a compact JSON identity blob (the QrPairing),
// ~290 bytes for an IPv4 host and up to ~341 for a 63-char hostname (v14).
//
// The algorithm follows ISO/IEC 18004: build the data bit stream (mode + count +
// bytes + terminator + pad), split into Reed–Solomon blocks over GF(256),
// interleave data then EC codewords, lay them into the module matrix in the
// zig-zag order, then try all eight masks and keep the lowest-penalty one.
// Returns a square boolean matrix (true = dark module), side = 4·version + 17.

// ---- Reed–Solomon over GF(256) (primitive poly 0x11d, α = 2) --------------
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];

// Generator polynomial for `degree` EC codewords: ∏ (x − α^i), coefficients
// high-order first, leading 1 dropped (it is implicit in the division below).
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly.slice(1);
}

// The `ecLen` error-correction codewords for one data block.
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const res = new Array<number>(ecLen).fill(0);
  for (const b of data) {
    const factor = b ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i], factor);
  }
  return res;
}

// ---- Version tables (EC level M only) -------------------------------------
// Per version: EC codewords per block, and the block groups as [count, dataLen].
type Group = [count: number, dataLen: number];
const EC_M: Record<number, { ec: number; groups: Group[] }> = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] },
  // v11–13 carry the same 16-bit byte count and 0 remainder bits as v10. They
  // exist because the real pairing blob — a 64-hex certificate SHA-256, a 43-char
  // device token and the LAN host — serialises to ~214 bytes, one over the 213 a
  // v10-M code holds. The brief scoped 1–10 from a ~180-char estimate; v11 (251 B)
  // covers the real payload with headroom for a longer hostname. Values per
  // ISO/IEC 18004 Table 9 (EC level M).
  11: { ec: 30, groups: [[1, 50], [4, 51]] },
  12: { ec: 22, groups: [[6, 36], [2, 37]] },
  13: { ec: 22, groups: [[8, 37], [1, 38]] },
  // v14 (365 data codewords → 362-byte capacity). The QrPairing blob — a 36-char
  // UUID collectorId, three ports, a 64-hex SHA-256 and a 43-char device token —
  // is ~290 bytes for an IPv4 host and grows with the hostname; a full 63-char DNS
  // label pushes it to ~341 bytes, one past v13's 331. v14 covers that with room to
  // spare. Values per ISO/IEC 18004 Table 9 (EC level M).
  14: { ec: 24, groups: [[4, 40], [5, 41]] },
};

// Alignment-pattern centre coordinates per version (empty for v1).
const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
};

const MAX_VERSION = 14;

const dataCodewords = (version: number): number =>
  EC_M[version].groups.reduce((n, [count, len]) => n + count * len, 0);

// Byte-mode character-count indicator width: 8 bits for v1–9, 16 for v10+.
const countBits = (version: number): number => (version < 10 ? 8 : 16);

// ---- Bit buffer -----------------------------------------------------------
class BitBuffer {
  bits: number[] = [];
  push(value: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

// ---- Encode ---------------------------------------------------------------
const utf8 = (text: string): number[] => Array.from(new TextEncoder().encode(text));

// Smallest version (1–14) whose data capacity holds this byte payload, else throw.
function pickVersion(byteLen: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const capacityBits = dataCodewords(v) * 8;
    const needed = 4 + countBits(v) + byteLen * 8;
    if (needed <= capacityBits) return v;
  }
  throw new Error(`QR payload too large for version ${MAX_VERSION} (EC M): ${byteLen} bytes`);
}

function buildCodewords(bytes: number[], version: number): number[] {
  const total = dataCodewords(version);
  const bb = new BitBuffer();
  bb.push(0b0100, 4); // byte mode
  bb.push(bytes.length, countBits(version));
  for (const b of bytes) bb.push(b, 8);
  // Terminator: up to four 0 bits, not past capacity.
  const capacity = total * 8;
  const term = Math.min(4, capacity - bb.bits.length);
  bb.push(0, term);
  // Pad to a byte boundary, then alternate 0xEC / 0x11 to fill the block.
  while (bb.bits.length % 8 !== 0) bb.bits.push(0);
  const words: number[] = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | bb.bits[i + j];
    words.push(w);
  }
  for (let pad = 0xec; words.length < total; pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}

// Split the data codewords into blocks, RS-encode each, then interleave data
// columns then EC columns (the standard placement order).
function interleave(data: number[], version: number): number[] {
  const { ec, groups } = EC_M[version];
  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const slice = data.slice(offset, offset + len);
      offset += len;
      blocks.push({ data: slice, ec: rsEncode(slice, ec) });
    }
  }
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let c = 0; c < maxData; c++) {
    for (const b of blocks) if (c < b.data.length) out.push(b.data[c]);
  }
  for (let c = 0; c < ec; c++) {
    for (const b of blocks) out.push(b.ec[c]);
  }
  return out;
}

// ---- Matrix construction --------------------------------------------------
type Matrix = { modules: boolean[][]; func: boolean[][]; size: number };

function newMatrix(size: number): Matrix {
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const func = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  return { modules, func, size };
}

// Set a module that belongs to a function pattern (marks it reserved).
function setFunc(m: Matrix, x: number, y: number, dark: boolean): void {
  m.modules[y][x] = dark;
  m.func[y][x] = true;
}

function drawFinder(m: Matrix, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < m.size && y >= 0 && y < m.size) setFunc(m, x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(m: Matrix, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunc(m, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFunctionPatterns(m: Matrix, version: number): void {
  const size = m.size;
  // Timing patterns.
  for (let i = 0; i < size; i++) {
    setFunc(m, 6, i, i % 2 === 0);
    setFunc(m, i, 6, i % 2 === 0);
  }
  // Finders at the three corners (each draws its separator via the clamp).
  drawFinder(m, 3, 3);
  drawFinder(m, size - 4, 3);
  drawFinder(m, 3, size - 4);
  // Alignment patterns at every centre-pair except the three finder corners.
  const pos = ALIGN[version];
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      drawAlignment(m, pos[i], pos[j]);
    }
  }
  // Reserve the format-info areas (filled per-mask later) and the dark module.
  reserveFormat(m);
  setFunc(m, 8, size - 8, true); // always-dark module at (8, 4·version+9)
  if (version >= 7) drawVersion(m, version);
}

// Mark the format-information cells as reserved (their values are set per mask).
function reserveFormat(m: Matrix): void {
  const size = m.size;
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { setFunc(m, 8, i, false); setFunc(m, i, 8, false); }
  }
  for (let i = 0; i < 8; i++) {
    setFunc(m, size - 1 - i, 8, false);
    setFunc(m, 8, size - 1 - i, false);
  }
}

function drawVersion(m: Matrix, version: number): void {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem; // 18 bits, no XOR mask
  const size = m.size;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunc(m, a, b, bit);
    setFunc(m, b, a, bit);
  }
}

// Format info: EC level M (formatBits 0) + mask, BCH(15,5), XOR 0x5412.
function drawFormat(m: Matrix, mask: number): void {
  const data = (0 << 3) | mask; // M → 0
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412; // 15 bits
  const size = m.size;
  const get = (i: number): boolean => ((bits >>> i) & 1) === 1;
  // First copy, around the top-left finder.
  for (let i = 0; i <= 5; i++) setFunc(m, 8, i, get(i));
  setFunc(m, 8, 7, get(6));
  setFunc(m, 8, 8, get(7));
  setFunc(m, 7, 8, get(8));
  for (let i = 9; i < 15; i++) setFunc(m, 14 - i, 8, get(i));
  // Second copy, split across the other two finders.
  for (let i = 0; i < 8; i++) setFunc(m, size - 1 - i, 8, get(i));
  for (let i = 8; i < 15; i++) setFunc(m, 8, size - 15 + i, get(i));
  setFunc(m, 8, size - 8, true); // dark module stays dark
}

// Lay the interleaved codewords into the matrix in the up/down zig-zag order,
// skipping reserved function cells; remainder bits are left as false.
function drawCodewords(m: Matrix, words: number[]): void {
  const size = m.size;
  let i = 0; // bit index
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!m.func[y][x] && i < words.length * 8) {
          m.modules[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

function maskCondition(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.func[y][x] && maskCondition(mask, x, y)) m.modules[y][x] = !m.modules[y][x];
    }
  }
}

// Standard four-rule penalty score; lower is better.
function penalty(m: Matrix): number {
  const size = m.size;
  const mod = m.modules;
  let score = 0;
  // Rule 1: runs of ≥5 same-colour modules per row and column.
  for (let y = 0; y < size; y++) {
    let runColor = mod[y][0];
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (mod[y][x] === runColor) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
      else { runColor = mod[y][x]; run = 1; }
    }
  }
  for (let x = 0; x < size; x++) {
    let runColor = mod[0][x];
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (mod[y][x] === runColor) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
      else { runColor = mod[y][x]; run = 1; }
    }
  }
  // Rule 2: 2×2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = mod[y][x];
      if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
    }
  }
  // Rule 3: finder-like 1:1:3:1:1 patterns in rows and columns.
  const p1 = [true, false, true, true, true, false, true, false, false, false, false];
  const p2 = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get: (i: number) => boolean, start: number, pat: boolean[]): boolean => {
    for (let k = 0; k < pat.length; k++) if (get(start + k) !== pat[k]) return false;
    return true;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x <= size - 11; x++) {
      const get = (i: number): boolean => mod[y][i];
      if (matches(get, x, p1) || matches(get, x, p2)) score += 40;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y <= size - 11; y++) {
      const get = (i: number): boolean => mod[i][x];
      if (matches(get, y, p1) || matches(get, y, p2)) score += 40;
    }
  }
  // Rule 4: overall dark-module proportion drift from 50%.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mod[y][x]) dark++;
  const percent = (dark * 100) / (size * size);
  const k = Math.floor(Math.abs(percent - 50) / 5);
  score += k * 10;
  return score;
}

/**
 * Encode `text` as a QR matrix (byte mode, EC level M). Returns a square
 * `boolean[][]` (`true` = dark), side length `4·version + 17`. Throws if the
 * payload exceeds version-14 capacity.
 */
export function encodeQr(text: string): boolean[][] {
  const bytes = utf8(text);
  const version = pickVersion(bytes.length);
  const words = interleave(buildCodewords(bytes, version), version);
  const size = version * 4 + 17;

  // Draw once with the codewords in place, then pick the best mask on a copy.
  const base = newMatrix(size);
  drawFunctionPatterns(base, version);
  drawCodewords(base, words);

  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const trial = newMatrix(size);
    trial.func = base.func.map((r) => r.slice());
    trial.modules = base.modules.map((r) => r.slice());
    applyMask(trial, mask);
    drawFormat(trial, mask);
    const s = penalty(trial);
    if (s < bestScore) { bestScore = s; best = trial.modules; }
  }
  return best as boolean[][];
}
