// A CLI failure carries the process exit code it should produce. main() prints the
// message to stderr and exits with `code`. The codes are the spec's contract:
//   1 general error, 2 authentication error, 3 collector unreachable.
export class CliError extends Error {
  constructor(message: string, public readonly code: number, public readonly reason?: 'forbidden_scope') {
    super(message);
    this.name = 'CliError';
  }
}

export const authError = (msg: string): CliError => new CliError(msg, 2);
// P3: the collector accepted the token but it is the read-only reader token and the
// route needs admin (403 `forbidden_scope`). An auth-class error (exit 2), tagged so
// a command with a reader-friendly fallback (status) can tell it apart.
export const scopeError = (): CliError =>
  new CliError('this command needs the admin token (reader token given)', 2, 'forbidden_scope');
export const isScopeError = (e: unknown): boolean => e instanceof CliError && e.reason === 'forbidden_scope';

// True when a 403 body is the collector's `{"error":"forbidden_scope"}`.
export function isForbiddenScopeBody(text: string): boolean {
  try { return (JSON.parse(text) as { error?: unknown } | null)?.error === 'forbidden_scope'; }
  catch { return false; }
}
export const generalError = (msg: string): CliError => new CliError(msg, 1);
// Collector unreachable: exit 3, with the spec's hint appended.
export const unreachableError = (host: string, port: number): CliError =>
  new CliError(
    `cannot reach collector at ${host}:${port} — is the collector running? npm start in collector/`,
    3,
  );
