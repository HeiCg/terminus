// Shell-completion generation (T7.4). The script is derived entirely from the
// command/flag tables (COMMANDS + GLOBAL_FLAGS), passed in as a CompletionModel by
// main.ts, so completions never drift from the real flags. It completes command
// names, per-command flags (plus the globals), and the value set of enum/status
// flags (`--body`, `--status`, `--source`).

export type CompletionFlag = {
  name: string;
  aliases: readonly string[];
  takesValue: boolean;
  // Fixed value set for an enum/status flag, else undefined.
  values?: readonly string[];
};

export type CompletionCommand = { name: string; summary: string; flags: CompletionFlag[] };
export type CompletionModel = { commands: CompletionCommand[]; globals: CompletionFlag[] };

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

// Long-form (`--name`) tokens for a flag list; short single-char aliases become `-x`.
function flagTokens(flags: CompletionFlag[]): string[] {
  const out: string[] = [];
  for (const f of flags) {
    out.push(`--${f.name}`);
    for (const a of f.aliases) out.push(a.length === 1 ? `-${a}` : `--${a}`);
  }
  return out;
}

// Every flag that offers a fixed value set, keyed by its long `--name`, collected
// once across the globals and all commands (a flag of the same name is identical).
function valueFlags(model: CompletionModel): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  const scan = (flags: CompletionFlag[]) => { for (const f of flags) if (f.values) out.set(f.name, f.values); };
  scan(model.globals);
  for (const c of model.commands) scan(c.flags);
  return out;
}

function bash(model: CompletionModel): string {
  const commands = model.commands.map((c) => c.name).join(' ');
  const globals = flagTokens(model.globals).join(' ');
  const valueCases = [...valueFlags(model)]
    .map(([name, vals]) => `    --${name}) COMPREPLY=( $(compgen -W ${JSON.stringify(vals.join(' '))} -- "$cur") ); return;;`)
    .join('\n');
  const cmdCases = model.commands
    .map((c) => `    ${c.name}) flags=${JSON.stringify(flagTokens(c.flags).join(' '))} ;;`)
    .join('\n');
  return `# terminus bash completion. Install: eval "$(terminus completion bash)"
_terminus() {
  local cur prev cmd flags i
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local commands=${JSON.stringify(commands)}
  cmd=""
  for ((i=1; i < COMP_CWORD; i++)); do
    case "\${COMP_WORDS[i]}" in
      -*) ;;
      *) cmd="\${COMP_WORDS[i]}"; break;;
    esac
  done
  if [[ -z "$cmd" ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return
  fi
  case "$prev" in
${valueCases}
  esac
  flags=""
  case "$cmd" in
${cmdCases}
  esac
  COMPREPLY=( $(compgen -W "$flags ${globals}" -- "$cur") )
}
complete -F _terminus terminus
`;
}

function zsh(model: CompletionModel): string {
  const commandLines = model.commands
    .map((c) => `      ${c.name}) flags=(${flagTokens(c.flags).map((t) => `'${t}'`).join(' ')}) ;;`)
    .join('\n');
  const globals = flagTokens(model.globals).map((t) => `'${t}'`).join(' ');
  const valueCases = [...valueFlags(model)]
    .map(([name, vals]) => `    --${name}) compadd ${vals.map((v) => `'${v}'`).join(' ')}; return;;`)
    .join('\n');
  const commandDescs = model.commands
    .map((c) => `    '${c.name}:${c.summary.replace(/'/g, '')}'`)
    .join('\n');
  return `#compdef terminus
# terminus zsh completion. Install: eval "$(terminus completion zsh)"
_terminus() {
  local -a commands flags
  commands=(
${commandDescs}
  )
  local cmd="" i
  for (( i=2; i < CURRENT; i++ )); do
    case "\${words[i]}" in
      -*) ;;
      *) cmd="\${words[i]}"; break;;
    esac
  done
  if [[ -z "$cmd" ]]; then
    _describe -t commands 'terminus command' commands
    return
  fi
  case "\${words[CURRENT-1]}" in
${valueCases}
  esac
  case "$cmd" in
${commandLines}
  esac
  flags+=(${globals})
  compadd -- "\${flags[@]}"
}
_terminus "$@"
`;
}

function fish(model: CompletionModel): string {
  const lines: string[] = [
    '# terminus fish completion. Install: terminus completion fish | source',
    'complete -c terminus -f',
  ];
  for (const c of model.commands) {
    const desc = c.summary.replace(/'/g, '');
    lines.push(`complete -c terminus -n '__fish_use_subcommand' -a '${c.name}' -d '${desc}'`);
  }
  const flagLine = (cond: string, f: CompletionFlag): string => {
    const parts = [`complete -c terminus`, `-n '${cond}'`, `-l ${f.name}`];
    for (const a of f.aliases) parts.push(a.length === 1 ? `-s ${a}` : `-l ${a}`);
    if (f.values) parts.push(`-x -a '${f.values.join(' ')}'`);
    else if (f.takesValue) parts.push('-r');
    return parts.join(' ');
  };
  for (const c of model.commands) {
    for (const f of c.flags) lines.push(flagLine(`__fish_seen_subcommand_from ${c.name}`, f));
  }
  // Globals apply once a subcommand is present.
  for (const f of model.globals) {
    const parts = [`complete -c terminus`, `-n 'not __fish_use_subcommand'`, `-l ${f.name}`];
    for (const a of f.aliases) parts.push(a.length === 1 ? `-s ${a}` : `-l ${a}`);
    if (f.values) parts.push(`-x -a '${f.values.join(' ')}'`);
    else if (f.takesValue) parts.push('-r');
    lines.push(parts.join(' '));
  }
  return lines.join('\n') + '\n';
}

export function generateCompletion(shell: CompletionShell, model: CompletionModel): string {
  switch (shell) {
    case 'bash': return bash(model);
    case 'zsh': return zsh(model);
    case 'fish': return fish(model);
  }
}
