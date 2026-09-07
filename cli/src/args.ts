// A tiny, dependency-free argument parser. No framework: subcommands are the first
// positional, flags come as `--flag value`, `--flag=value` or bare booleans, and a
// short `-x` is a boolean unless named as a value flag. Which flags take a value is
// declared per call (`valueFlags`) so `--last 50` reads 50 as the value while
// `--json` stays boolean and 50 does not leak into the positionals.

export type Flags = Record<string, string | boolean>;

export type ParsedArgs = {
  // The first positional token, e.g. `status` in `terminus status --json`.
  command: string | undefined;
  // Positionals after the command, e.g. `d1/r1` in `terminus show d1/r1`.
  positionals: string[];
  flags: Flags;
  // True when `-h`/`--help` appeared anywhere.
  help: boolean;
};

export type ParseOptions = {
  // Long or short flag names (without dashes) that consume the next token as their
  // value when it is not itself a flag. Everything else is a boolean flag.
  valueFlags?: string[];
};

// A flag token starts with '-' and is not a negative number: `-h`/`--last` are
// flags, but `-1`/`-2.5` are values (so `--last -1` reads -1 as the value).
const isFlagToken = (t: string): boolean => t.length > 1 && t.startsWith('-') && !/^-\d/.test(t);

export function parseArgs(argv: string[], opts: ParseOptions = {}): ParsedArgs {
  const valueFlags = new Set(opts.valueFlags ?? []);
  const flags: Flags = {};
  const positionals: string[] = [];
  let rest = false; // everything after a bare `--` is positional

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (rest) { positionals.push(tok); continue; }
    if (tok === '--') { rest = true; continue; }

    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
      if (valueFlags.has(body) && i + 1 < argv.length && !isFlagToken(argv[i + 1])) {
        flags[body] = argv[++i];
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (isFlagToken(tok)) {
      const name = tok.slice(1);
      if (valueFlags.has(name) && i + 1 < argv.length && !isFlagToken(argv[i + 1])) {
        flags[name] = argv[++i];
      } else {
        flags[name] = true;
      }
      continue;
    }

    positionals.push(tok);
  }

  const command = positionals.shift();
  const help = flags.h === true || flags.help === true;
  return { command, positionals, flags, help };
}

// Read a flag as a string, or undefined when absent or given as a bare boolean.
// Accepts any of several aliases (e.g. long + short) and returns the first present.
export function flagString(flags: Flags, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = flags[n];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

// Read a flag as a boolean: present as `--flag` or `--flag=true`/`1`/`yes`.
export function flagBool(flags: Flags, ...names: string[]): boolean {
  for (const n of names) {
    const v = flags[n];
    if (v === true) return true;
    if (typeof v === 'string') return v === '' || v === 'true' || v === '1' || v === 'yes';
  }
  return false;
}
