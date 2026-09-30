import type { CommandError, ErrorCode } from "@svg-editor/model";
import type { ParseError, ParseErrorCode } from "@svg-editor/parser";

/** Every code an SDK call can fail with. */
export type SdkErrorCode =
  | ErrorCode
  | "PARSE_ERROR"
  | "NO_RASTERIZER"
  | "EXPORT_FAILED"
  | "LOCKED"
  | "LOCK_RELEASED"
  | "LOCK_STOPPED";

/**
 * The one error type the SDK throws. `code` is stable and meant for programs
 * (and the AI) to branch on; `message` says what went wrong; `hint` says what
 * to do instead.
 */
export class SvgEditorError extends Error {
  override readonly name = "SvgEditorError";
  readonly code: SdkErrorCode;
  readonly hint: string;
  /** For batch failures: index path to the failing command. */
  readonly path?: number[];
  /** For PARSE_ERROR: where and why the text did not parse. */
  readonly parse?: { code: ParseErrorCode; offset: number; line: number; column: number };

  constructor(
    code: SdkErrorCode,
    message: string,
    hint: string,
    extra: { path?: number[] | undefined; parse?: SvgEditorError["parse"] } = {},
  ) {
    super(message);
    this.code = code;
    this.hint = hint;
    if (extra.path) this.path = extra.path;
    if (extra.parse) this.parse = extra.parse;
  }

  /** Plain data, e.g. to hand back to an AI tool call. */
  toJSON(): { code: SdkErrorCode; message: string; hint: string; path?: number[]; parse?: SvgEditorError["parse"] } {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      ...(this.path ? { path: this.path } : {}),
      ...(this.parse ? { parse: this.parse } : {}),
    };
  }

  static fromCommand(e: CommandError): SvgEditorError {
    const cause = e.cause ?? e;
    return new SvgEditorError(e.code, e.message, cause.hint, { path: e.path });
  }

  static fromParse(e: ParseError): SvgEditorError {
    return new SvgEditorError("PARSE_ERROR", `Line ${e.line}, column ${e.column}: ${e.message}`, e.hint, {
      parse: { code: e.code, offset: e.offset, line: e.line, column: e.column },
    });
  }
}
