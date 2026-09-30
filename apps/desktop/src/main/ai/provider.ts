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
}

export interface Provider {
  runTurn(args: TurnArgs): Promise<TurnResult>;
  /** One tiny request that exercises tool calling; resolves with a user-facing message. */
  test(settings: AiSettings, apiKey: string | null, signal: AbortSignal): Promise<string>;
}

/** A tool the connection test asks the model to call. */
export const PING_TOOL = {
  name: "ping",
  description: "Connection check. Call this tool once.",
  input_schema: { type: "object" as const, properties: {}, additionalProperties: false },
};
