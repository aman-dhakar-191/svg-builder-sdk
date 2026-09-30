import type { CommandError, ErrorCode } from "./types.js";

/**
 * Thrown inside command handlers to abort the command. `execute` catches it,
 * rolls back any partial changes, and returns it as `{ ok: false, error }`.
 */
export class CommandFailure extends Error {
  readonly error: CommandError;

  constructor(error: CommandError) {
    super(`${error.code}: ${error.message}`);
    this.name = "CommandFailure";
    this.error = error;
  }
}

export function fail(code: ErrorCode, message: string, hint: string): never {
  throw new CommandFailure({ code, message, hint });
}
