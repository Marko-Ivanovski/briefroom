/** A failure the user should read as a message, not a stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
