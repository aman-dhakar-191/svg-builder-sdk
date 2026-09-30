import type { AiSettings, AiToolOutcome } from "../../shared/ai.js";

/** One user turn: the provider loops (model -> tools -> model) until the model is done. */
export interface TurnArgs {
  settings: AiSettings;
  apiKey: string | null;
  userText: string;
  /** Provider-owned conversation history, appended in place (kept between turns). */
  history: unknown[];
  signal: AbortSignal;
  callTool(name: string, input: unknown): Promise<AiToolOutcome>;
  onText(delta: string): void;
  maxToolRounds: number;
}

export type TurnStatus = "done" | "refused" | "limit";

export interface TurnResult {
  status: TurnStatus;
  text: string;
  message?: string;
}

/** Errors meant for the user, with a message that says what to fix. */
export class ProviderError extends Error {
  override readonly name = "ProviderError";
  constructor(
    message: string,
    /** HTTP status, when the API answered with an error. */
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface Provider {
  runTurn(args: TurnArgs): Promise<TurnResult>;
  /** One tiny request that exercises tool calling; resolves with a user-facing message. */
  test(settings: AiSettings, apiKey: string | null, signal: AbortSignal): Promise<string>;
  /** Model IDs the endpoint offers (for the model picker). */
  listModels(settings: AiSettings, apiKey: string | null, signal: AbortSignal): Promise<string[]>;
}

/** A tool the connection test asks the model to call. */
export const PING_TOOL = {
  name: "ping",
  description: "Connection check. Call this tool once.",
  input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
};

/** A 1x1 PNG: Test connection sends it when image input is on, to check the model accepts images. */
export const TEST_IMAGE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

export const NO_VISION_MESSAGE = "this model does not accept images. Turn off \"Model can see images\" in AI settings (the AI then works without snapshots).";

/** Placeholder for snapshots from earlier turns, which are dropped to keep requests small. */
export const OLD_SNAPSHOT_TEXT = "[snapshot from an earlier turn omitted]";

/** Starts a new model response's text on its own paragraph (a turn has several responses). */
export function paragraph(before: string, next: string): string {
  if (!before || /\s$/.test(before) || /^\s/.test(next)) return next;
  return `\n\n${next}`;
}
