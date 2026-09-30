/** Types shared by the main process (model calls) and the renderer (chat UI, tool dispatch). */

export type ApiFormat = "anthropic" | "openai-compatible";
/** "default" sends no effort setting (not every model accepts one). */
export type Effort = "default" | "low" | "medium" | "high";

export interface AiSettings {
  format: ApiFormat;
  /** Empty = the provider's official endpoint. */
  baseUrl: string;
  model: string;
  effort: Effort;
}

/** What the renderer sees: never the key itself. */
export interface AiSettingsView extends AiSettings {
  hasKey: boolean;
  /** "keychain": encrypted by the OS; "session": this OS offers no secure store, kept in memory until the app quits. */
  keyStorage: "keychain" | "session";
  /** Anthropic's server-side fallback is on (official API, supported model): a declined request is retried on another model. */
  serverFallback: boolean;
}

export interface AiSettingsUpdate extends AiSettings {
  /** New key; null clears it; omitted keeps the current one. */
  apiKey?: string | null;
}

export const DEFAULT_AI_SETTINGS: AiSettings = { format: "anthropic", baseUrl: "", model: "claude-opus-5-5", effort: "default" };

export interface AiTestResult {
  ok: boolean;
  message: string;
}

/** Streamed to the renderer while a turn runs. */
export type AiEvent =
  | { turnId: string; type: "text"; delta: string }
  | { turnId: string; type: "notice"; message: string };

/** The main process asks the renderer to run a tool against the document. */
export interface AiToolCall {
  turnId: string;
  callId: string;
  name: string;
  input: unknown;
}

export type AiToolOutcome = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; hint: string } };

export interface AiRunResult {
  /** done: finished; stopped: user pressed Stop; refused: model declined; limit: too many tool rounds; error: see message. */
  status: "done" | "stopped" | "refused" | "limit" | "error";
  text: string;
  message?: string;
}
