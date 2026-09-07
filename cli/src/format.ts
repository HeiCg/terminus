// Terminal formatting primitives: colour (only on a TTY without NO_COLOR),
// fixed-width cells, and path truncation with an ellipsis. All width-aware output
// funnels through here so a command never hand-rolls ANSI or padding.

const CODES = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  gray: '\x1b[90m', green: '\x1b[32m', blue: '\x1b[34m', yellow: '\x1b[33m', red: '\x1b[31m',
} as const;

export type Colors = {
  enabled: boolean;
  bold(s: string): string; dim(s: string): string; gray(s: string): string;
  green(s: string): string; blue(s: string): string; yellow(s: string): string; red(s: string): string;
};

export function makeColors(enabled: boolean): Colors {
  const wrap = (code: string) => (s: string) => (enabled ? code + s + CODES.reset : s);
  return {
    enabled,
    bold: wrap(CODES.bold), dim: wrap(CODES.dim), gray: wrap(CODES.gray),
    green: wrap(CODES.green), blue: wrap(CODES.blue), yellow: wrap(CODES.yellow), red: wrap(CODES.red),
  };
}

// Colour decision: honour NO_COLOR (any value disables), otherwise only when the
// destination is a real terminal.
export function colorEnabled(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env.NO_COLOR != null) return false;
  return isTTY;
}

// Pad/truncate a cell to exactly `width` visible characters. Truncation keeps the
// tail readable by cutting the head is not wanted here; we cut the tail and mark it
// with an ellipsis. Padding is right (left-aligned text) unless `align: 'right'`.
export function cell(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (width <= 0) return '';
  let t = text;
  if (t.length > width) t = width <= 1 ? '…' : t.slice(0, width - 1) + '…';
  const pad = ' '.repeat(width - t.length);
  return align === 'right' ? pad + t : t + pad;
}

// Truncate free text (a host+path) to a max width with a trailing ellipsis, no
// padding. Used for the last, flexible column.
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return max <= 1 ? '…' : text.slice(0, max - 1) + '…';
}

// A short local wall-clock time (HH:MM:SS) from an epoch-ms timestamp.
export function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// A compact duration: `-` when null, `<1ms` under a millisecond, else `NNNms` or
// `N.Ns` past a second so the column stays narrow.
export function duration(ms: number | null): string {
  if (ms == null) return '-';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
