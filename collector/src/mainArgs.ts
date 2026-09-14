// The collector historically parsed no argv (configuration is all environment
// variables). T7.3 adds a minimal parser for the few command-line options it now
// accepts: `--load <path>` (repeatable) to import a capture file at start, and
// `--help`/`--version`. Unknown tokens are collected so main() can warn without
// failing an existing invocation.

export type CollectorArgs = { loads: string[]; help: boolean; version: boolean; unknown: string[] };

export function parseCollectorArgs(argv: string[]): CollectorArgs {
  const loads: string[] = [];
  const unknown: string[] = [];
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--version' || a === '-V') version = true;
    else if (a === '--load') {
      const v = argv[i + 1];
      if (v != null && !v.startsWith('-')) { loads.push(v); i++; }
      else unknown.push('--load (missing path)');
    } else if (a.startsWith('--load=')) {
      loads.push(a.slice('--load='.length));
    } else {
      unknown.push(a);
    }
  }
  return { loads, help, version, unknown };
}

export const COLLECTOR_USAGE = `terminus collector — capture proxy for local device traffic

Usage: node dist/main.js [options]

Options:
  --load <file>    import a Terminus HAR (.har) or JSON (.json) export at start
                   (repeatable)
  --help, -h       show this help
  --version, -V    print the collector version

Configuration is via environment variables; see collector/README.md.
`;
