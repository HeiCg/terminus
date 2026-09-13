import type { Flags } from './args.js';

// Per-command flag declarations. `main.ts` parses argv into a flag bag, then this
// module checks that bag against the command's table: every flag is known, every
// value-taking flag got a value of the right shape, and enums/status tokens are in
// range. The same table drives per-command `--help`. Booleans never take a value;
// the other kinds do. `status` is its own kind — a comma-list of exact codes and
// `Nxx` classes (see filters.ts), not a fixed enum.
export type FlagType = 'boolean' | 'string' | 'number' | 'enum' | 'status';

export type FlagSpec = {
  type: FlagType;
  // Accepted tokens for `enum`.
  values?: readonly string[];
  // Extra names for the same flag (e.g. the short `o` for `output`).
  aliases?: readonly string[];
  // Placeholder shown in `--help` after a value flag (e.g. `N`, `<id>`).
  arg?: string;
  help: string;
};

export type CommandSpec = {
  summary: string;
  // Positional argument shape for `--help` (e.g. `<dev>/<key>`), if any.
  usage?: string;
  flags: Record<string, FlagSpec>;
};

// Flags accepted on every command: the connection triple, JSON output, help and
// version. They are validated/handled centrally, so commands need not list them.
export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  host: { type: 'string', arg: '<h>', help: 'collector host (default 127.0.0.1; a traffic filter on tail/ls)' },
  port: { type: 'number', arg: '<p>', help: 'collector port (default 8787)' },
  token: { type: 'string', arg: '<t>', help: 'admin token (else TERMINUS_TOKEN or the state-dir file)' },
  json: { type: 'boolean', help: 'machine-readable output' },
  help: { type: 'boolean', aliases: ['h'], help: 'show this help' },
  version: { type: 'boolean', aliases: ['V'], help: 'print the CLI version' },
};

// Every value-taking flag name (canonical + aliases) across the globals and a set of
// command tables — the superset the single parse pass needs so `--flag value` reads
// the value rather than swallowing it as a boolean.
export function valueFlagNames(commands: Record<string, CommandSpec>): string[] {
  const out = new Set<string>();
  const add = (name: string, spec: FlagSpec): void => {
    if (spec.type === 'boolean') return;
    out.add(name);
    for (const a of spec.aliases ?? []) out.add(a);
  };
  for (const [n, s] of Object.entries(GLOBAL_FLAGS)) add(n, s);
  for (const cmd of Object.values(commands)) for (const [n, s] of Object.entries(cmd.flags)) add(n, s);
  return [...out];
}

// A status token is a class `1xx`–`5xx` or an exact integer code (see filters.ts).
function statusTokenValid(tok: string): boolean {
  const t = tok.trim().toLowerCase();
  if (/^[1-5]xx$/.test(t)) return true;
  const n = Number(t);
  return Number.isInteger(n) && t !== '';
}

// Levenshtein distance, small and iterative — used only to suggest a near miss for
// an unknown flag, so it never runs on hot paths.
function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[a.length];
}

function suggest(name: string, allowed: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const cand of allowed) {
    const d = distance(name, cand);
    if (d < bestD) { bestD = d; best = cand; }
  }
  // Only suggest a genuinely close match, and never for a 1-char typo target.
  return best && bestD <= 2 && best.length > 1 ? best : undefined;
}

// Validate the parsed flag bag against a command's table (plus the globals). Returns
// an error message (the caller prints it to stderr and exits 1) or null when clean.
export function validateFlags(command: string, flags: Flags, spec: CommandSpec): string | null {
  // Resolve every accepted name (canonical + alias) to its canonical spec.
  const byName = new Map<string, { name: string; spec: FlagSpec }>();
  const register = (table: Record<string, FlagSpec>): void => {
    for (const [name, s] of Object.entries(table)) {
      byName.set(name, { name, spec: s });
      for (const a of s.aliases ?? []) byName.set(a, { name, spec: s });
    }
  };
  register(GLOBAL_FLAGS);
  register(spec.flags);

  for (const key of Object.keys(flags)) {
    const hit = byName.get(key);
    if (!hit) {
      // Suggest against the command's own flags first, then the globals.
      const s = suggest(key, byName.keys());
      const hint = s ? ` (did you mean --${s}?)` : '';
      return `unknown flag --${key}${hint}\nrun \`terminus ${command} --help\` for the accepted flags`;
    }
    const value = flags[key];
    const { name, spec: fs } = hit;
    if (fs.type === 'boolean') continue;
    // A value flag with no value (bare `--limit`) parses as boolean true.
    if (value === true) return `flag --${name} needs a value`;
    const raw = String(value);
    if (fs.type === 'number') {
      if (raw.trim() === '' || !Number.isFinite(Number(raw))) return `flag --${name} expects a number, got "${raw}"`;
    } else if (fs.type === 'enum') {
      if (!fs.values?.includes(raw)) return `invalid --${name}: "${raw}" (accepted: ${fs.values?.join(', ')})`;
    } else if (fs.type === 'status') {
      const bad = raw.split(',').map((t) => t.trim()).filter(Boolean).find((t) => !statusTokenValid(t));
      if (bad !== undefined || raw.trim() === '') {
        return `invalid --${name}: "${raw}" (accepted: exact codes like 200/404, classes 1xx–5xx, comma-separated)`;
      }
    }
  }
  return null;
}

// Render `terminus <command> --help`: the summary, a usage line, and the command's
// own flags followed by the common connection/output flags.
export function commandHelp(command: string, spec: CommandSpec): string {
  const label = (name: string, fs: FlagSpec): string => {
    const names = [name, ...(fs.aliases ?? [])].map((n) => (n.length === 1 ? `-${n}` : `--${n}`)).join(', ');
    return fs.type === 'boolean' || !fs.arg ? names : `${names} ${fs.arg}`;
  };
  const rows = (table: Record<string, FlagSpec>): string[] => {
    const entries = Object.entries(table);
    const labels = entries.map(([n, fs]) => label(n, fs));
    const width = Math.max(0, ...labels.map((l) => l.length));
    return entries.map(([, fs], i) => `  ${labels[i].padEnd(width)}  ${fs.help}`);
  };
  const own = Object.keys(spec.flags).length ? ['', 'Options:', ...rows(spec.flags)] : [];
  const usage = spec.usage ? ` ${spec.usage}` : '';
  return [
    `terminus ${command} — ${spec.summary}`,
    '',
    `Usage: terminus ${command}${usage} [options]`,
    ...own,
    '',
    'Common:',
    ...rows(GLOBAL_FLAGS),
    '',
  ].join('\n');
}
