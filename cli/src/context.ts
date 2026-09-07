import type { Config } from './config.js';
import type { Flags } from './args.js';
import type { Colors } from './format.js';

// Everything a command needs, injected so tests can drive a command in-process
// without spawning a binary: the resolved connection, the parsed flags/positionals,
// output sinks (captured in tests), colour state, terminal width, and an optional
// abort signal for the long-running `tail`.
export type Ctx = {
  config: Config;
  flags: Flags;
  positionals: string[];
  json: boolean;
  colors: Colors;
  columns: number;
  // Raw write (no trailing newline) — used for streamed exports.
  out(s: string): void;
  err(s: string): void;
  signal?: AbortSignal;
};

// Write one line to stdout.
export const line = (ctx: Ctx, s = ''): void => ctx.out(s + '\n');
// Write one line to stderr.
export const errline = (ctx: Ctx, s = ''): void => ctx.err(s + '\n');
// Pretty one-line or indented JSON for `--json` output.
export const jsonLine = (ctx: Ctx, value: unknown): void => ctx.out(JSON.stringify(value, null, 2) + '\n');

export type { Config, Flags, Colors };
