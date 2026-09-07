// A CLI failure carries the process exit code it should produce. main() prints the
// message to stderr and exits with `code`. The codes are the spec's contract:
//   1 general error, 2 authentication error, 3 collector unreachable.
export class CliError extends Error {
  constructor(message: string, public readonly code: number) {
    super(message);
    this.name = 'CliError';
  }
}

export const authError = (msg: string): CliError => new CliError(msg, 2);
export const generalError = (msg: string): CliError => new CliError(msg, 1);
// Collector unreachable: exit 3, with the spec's hint appended.
export const unreachableError = (host: string, port: number): CliError =>
  new CliError(
    `cannot reach collector at ${host}:${port} — is the collector running? npm start in collector/`,
    3,
  );
