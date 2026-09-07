// Render a QR module matrix as Unicode half-blocks: two matrix rows share one text
// line, so the code stays roughly square in a terminal cell grid. A dark module is
// drawn as its half-block glyph; light is a space.
//
//   top dark + bottom dark -> █    top dark only -> ▀
//   bottom dark only       -> ▄    neither       -> (space)
//
// The pair (`toHalfBlocks`) and its inverse (`fromHalfBlocks`) are exposed so a test
// can render then decode back to the exact matrix, proving the rendering is lossless
// and matches the shared encoder.

const FULL = '█', UPPER = '▀', LOWER = '▄', BLANK = ' ';

// Expand a matrix with a light quiet zone of `n` modules on all sides — a scanner
// needs the margin. The default 2 is enough for a screen QR.
export function withQuiet(matrix: boolean[][], n = 2): boolean[][] {
  if (n <= 0) return matrix;
  const width = (matrix[0]?.length ?? 0) + n * 2;
  const blankRow = (): boolean[] => new Array<boolean>(width).fill(false);
  const out: boolean[][] = [];
  for (let i = 0; i < n; i++) out.push(blankRow());
  for (const row of matrix) out.push([...new Array<boolean>(n).fill(false), ...row, ...new Array<boolean>(n).fill(false)]);
  for (let i = 0; i < n; i++) out.push(blankRow());
  return out;
}

// One text line per two matrix rows. A final unpaired row (odd height) is drawn with
// a light bottom half.
export function toHalfBlocks(matrix: boolean[][]): string[] {
  const lines: string[] = [];
  for (let y = 0; y < matrix.length; y += 2) {
    const top = matrix[y];
    const bottom = matrix[y + 1];
    let s = '';
    for (let x = 0; x < top.length; x++) {
      const t = top[x] === true;
      const b = bottom ? bottom[x] === true : false;
      s += t && b ? FULL : t ? UPPER : b ? LOWER : BLANK;
    }
    lines.push(s);
  }
  return lines;
}

// A scanner needs a light margin; 4 modules is the QR-spec quiet zone.
export const QUIET_ZONE = 4;

// White background + black foreground for the whole block, so dark-theme terminals
// (light default foreground on a dark ground) do not render an inverted, unscannable
// code. Reset at end of each line.
const BLOCK_ON = '\x1b[30;47m';
const BLOCK_OFF = '\x1b[0m';

// The lines to print for a QR matrix: half-blocks with the 4-module quiet zone. With
// `color`, each line is wrapped in explicit white-bg/black-fg so the code reads the
// same in any terminal theme; without it (a --no-color / non-TTY sink), plain
// half-blocks — still with the quiet zone, so it stays scannable.
export function qrLines(matrix: boolean[][], opts: { color: boolean }): string[] {
  const lines = toHalfBlocks(withQuiet(matrix, QUIET_ZONE));
  return opts.color ? lines.map((l) => BLOCK_ON + l + BLOCK_OFF) : lines;
}

// Decode half-block lines back into a module matrix (even height: each line yields a
// top and bottom row). A caller that started from an odd-height matrix slices off the
// trailing light row.
export function fromHalfBlocks(lines: string[]): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of lines) {
    const chars = Array.from(line);
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const ch of chars) {
      top.push(ch === FULL || ch === UPPER);
      bottom.push(ch === FULL || ch === LOWER);
    }
    rows.push(top, bottom);
  }
  return rows;
}
