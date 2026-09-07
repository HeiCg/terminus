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

// Every value-taking flag across all commands. Parsing is one pass with this
// superset (a boolean flag is never listed, so it never swallows the next token),
// then the command is dispatched on the first positional.
const VALUE_FLAGS = [
  'host', 'port', 'token', 'last', 'limit', 'device', 'method', 'status', 'path', 'body', 'o', 'output',
];

type Command = { run: (ctx: Ctx) => Promise<number>; hostIsFilter?: boolean };

// `status` and `pause`/`resume` etc. are commands; `--status`/`--host` are flags.
// The two never collide because the command is a positional and the flags are not.
const COMMANDS: Record<string, Command> = {
  status: { run: runStatus },
  tail: { run: runTail, hostIsFilter: true },
  ls: { run: runLs, hostIsFilter: true },
  show: { run: runShow },
  export: { run: runExport },
  pause: { run: runPause },
  resume: { run: runResume },
  clear: { run: runClear },
  devices: { run: runDevices },
  pair: { run: runPair },
};

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

  if (!parsed.command || parsed.command === 'help') { deps.stdout.write(USAGE); return 0; }
  const cmd = COMMANDS[parsed.command];
  if (!cmd) { deps.stderr.write(`unknown command: ${parsed.command}\n\n${USAGE}`); return 1; }
  if (parsed.help) { deps.stdout.write(USAGE); return 0; }

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
