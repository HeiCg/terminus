import { parseArgs } from './args.js';
import { resolveConfig } from './config.js';
import { makeColors, colorEnabled } from './format.js';
import { CliError } from './errors.js';
import type { Ctx } from './context.js';
import { runStatus } from './commands/status.js';
import { runTail } from './commands/tail.js';
import { runLs } from './commands/ls.js';
import { runShow } from './commands/show.js';
import { runExport } from './commands/exportCmd.js';
import { runPause, runResume } from './commands/pauseResume.js';
import { runClear } from './commands/clear.js';
import { runDevices } from './commands/devices.js';
import { runPair } from './commands/pair.js';
import { VERSION } from './version.js';
import { type CommandSpec, valueFlagNames, validateFlags, commandHelp } from './flagspec.js';

// Filters shared by `tail` and `ls`, declared once so both tables (and their
// `--help`) stay in sync.
const FILTER_FLAGS: CommandSpec['flags'] = {
  device: { type: 'string', arg: '<id>', help: 'only this device' },
  method: { type: 'string', arg: '<list>', help: 'comma-list of HTTP methods, e.g. GET,POST' },
  status: { type: 'status', arg: '<list>', help: 'codes/classes, e.g. 200,4xx,5xx' },
  host: { type: 'string', arg: '<substr>', help: 'host substring match' },
  path: { type: 'string', arg: '<substr>', help: 'path substring match' },
  errors: { type: 'boolean', help: 'only transport errors and 4xx/5xx' },
};

type Command = { run: (ctx: Ctx) => Promise<number>; hostIsFilter?: boolean; spec: CommandSpec };

// `status` and `pause`/`resume` etc. are commands; `--status`/`--host` are flags.
// The two never collide because the command is a positional and the flags are not.
// Each command carries a flag table: `main()` validates the parsed flags against it
// (unknown flag / bad value → exit 1) and `--help` renders it.
const COMMANDS: Record<string, Command> = {
  status: { run: runStatus, spec: { summary: 'collector snapshot (devices, counts, paused, retention)', flags: {} } },
  tail: {
    run: runTail, hostIsFilter: true,
    spec: {
      summary: 'follow live traffic (Ctrl-C to stop)',
      flags: {
        ...FILTER_FLAGS,
        last: { type: 'number', arg: 'N', help: 'entries from the initial snapshot to show (default 50)' },
        'no-reconnect': { type: 'boolean', help: 'exit 3 on a dropped connection instead of reconnecting' },
      },
    },
  },
  ls: {
    run: runLs, hostIsFilter: true,
    spec: {
      summary: 'list captured entries',
      flags: {
        ...FILTER_FLAGS,
        limit: { type: 'number', arg: 'N', help: 'stop after N matches (paginates when filters are set)' },
        all: { type: 'boolean', help: 'follow pagination to the end of the store' },
      },
    },
  },
  show: {
    run: runShow,
    spec: {
      summary: 'one entry: headers, timing, bodies',
      usage: '<dev>/<key>',
      flags: {
        body: { type: 'enum', values: ['request', 'response', 'both', 'none'], arg: '<which>', help: 'which bodies to print (default both)' },
        curl: { type: 'boolean', help: 'print a reproduction curl command' },
      },
    },
  },
  export: {
    run: runExport,
    spec: {
      summary: 'download the capture',
      flags: {
        har: { type: 'boolean', help: 'HAR format (default)' },
        o: { type: 'string', aliases: ['output'], arg: '<file>', help: 'write to a file (default stdout)' },
      },
    },
  },
  pause: { run: runPause, spec: { summary: 'pause the live stream', flags: {} } },
  resume: { run: runResume, spec: { summary: 'resume the live stream', flags: {} } },
  clear: {
    run: runClear,
    spec: { summary: 'drop captured data', flags: { device: { type: 'string', arg: '<id>', help: 'only this device' } } },
  },
  devices: { run: runDevices, spec: { summary: 'list paired devices', flags: {} } },
  pair: {
    run: runPair,
    spec: { summary: 'show pairing (QR contains the device token)', flags: { qr: { type: 'boolean', help: 'render a scannable QR' } } },
  },
};

// The parse-time value-flag superset, derived from the tables so it never drifts.
const VALUE_FLAGS = valueFlagNames(Object.fromEntries(Object.entries(COMMANDS).map(([k, c]) => [k, c.spec])));

const USAGE = `terminus — talk to a local Terminus collector

Usage: terminus <command> [options]

Commands:
  status                 collector snapshot (devices, counts, paused, retention)
  tail [filters]         follow live traffic (Ctrl-C to stop); --last N, --json (NDJSON)
  ls [filters]           list captured entries; --limit N, --all
  show <dev>/<key>       one entry: headers, timing, bodies; --body req|res|none, --curl
  export [--har|--json]  download capture; -o <file> (default stdout)
  pause | resume         toggle the live stream
  clear [--device <id>]  drop captured data
  devices                list paired devices
  pair [--qr|--json]     show pairing (QR contains the device token)

Common filters (tail, ls): --device <id> --method GET,POST --status 4xx|5xx|200
                           --host <substr> --path <substr> --errors

Connection: --host <h> (default 127.0.0.1) --port <p> (default 8787)
Auth:       --token <t> | TERMINUS_TOKEN | admin-token file in the state dir
Output:     --json for machine-readable output; NO_COLOR disables colour
Help:       terminus <command> --help for a command's flags
Version:    terminus --version | -V
`;

export type MainDeps = {
  env: NodeJS.ProcessEnv;
  stdout: { write(s: string): void; isTTY?: boolean; columns?: number };
  stderr: { write(s: string): void };
  stateDir?: string;
  signal?: AbortSignal;
};

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  const parsed = parseArgs(argv, { valueFlags: VALUE_FLAGS });

  // `--version`/`-V` wins anywhere, before any command dispatch or help.
  if (parsed.flags.version === true || parsed.flags.V === true) { deps.stdout.write(`${VERSION}\n`); return 0; }

  if (!parsed.command || parsed.command === 'help') { deps.stdout.write(USAGE); return 0; }
  const cmd = COMMANDS[parsed.command];
  if (!cmd) { deps.stderr.write(`unknown command: ${parsed.command}\n\n${USAGE}`); return 1; }
  // `terminus <command> --help` prints the command's own flags, not the global usage.
  if (parsed.help) { deps.stdout.write(commandHelp(parsed.command, cmd.spec)); return 0; }

  // Reject unknown flags and malformed values before doing any work.
  const flagError = validateFlags(parsed.command, parsed.flags, cmd.spec);
  if (flagError) { deps.stderr.write(`${flagError}\n`); return 1; }

  const colors = makeColors(colorEnabled(deps.env, deps.stdout.isTTY ?? false));
  try {
    const config = resolveConfig({
      flags: parsed.flags, env: deps.env, stateDir: deps.stateDir, hostIsFilter: cmd.hostIsFilter,
    });
    const ctx: Ctx = {
      config,
      flags: parsed.flags,
      positionals: parsed.positionals,
      json: parsed.flags.json === true,
      colors,
      columns: deps.stdout.columns ?? 80,
      out: (s) => deps.stdout.write(s),
      err: (s) => deps.stderr.write(s),
      signal: deps.signal,
      env: deps.env,
    };
    return await cmd.run(ctx);
  } catch (e) {
    if (e instanceof CliError) { deps.stderr.write(`${e.message}\n`); return e.code; }
    deps.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

// Wire the CLI to the real process and run one command. The bin entry
// (`bin/terminus.js`) calls this unconditionally; importing this module (tests)
// never runs it. Ctrl-C aborts the (only) long-running command, `tail`, so its
// socket closes cleanly; a second Ctrl-C exits hard.
export async function run(): Promise<void> {
  const controller = new AbortController();
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    controller.abort();
  });
  const code = await main(process.argv.slice(2), {
    env: process.env,
    stdout: { write: (s) => process.stdout.write(s), isTTY: process.stdout.isTTY, columns: process.stdout.columns },
    stderr: { write: (s) => process.stderr.write(s) },
    signal: controller.signal,
  });
  process.exit(code);
}
