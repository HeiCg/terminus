import { type Ctx } from '../context.js';
import { generateCompletion, COMPLETION_SHELLS, type CompletionModel, type CompletionShell } from '../completion.js';
import { generalError } from '../errors.js';

// `terminus completion <bash|zsh|fish>` prints the completion script for the shell,
// generated from the live command/flag tables (passed as `model`). Raw output (no
// added newline) so `eval "$(terminus completion zsh)"` sees the script verbatim.
export async function runCompletion(ctx: Ctx, model: CompletionModel): Promise<number> {
  const shell = ctx.positionals[0];
  if (!shell || !(COMPLETION_SHELLS as readonly string[]).includes(shell)) {
    throw generalError(`usage: terminus completion <${COMPLETION_SHELLS.join('|')}>`);
  }
  ctx.out(generateCompletion(shell as CompletionShell, model));
  return 0;
}
