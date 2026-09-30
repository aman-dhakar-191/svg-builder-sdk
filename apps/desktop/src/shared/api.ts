/** The bridge between renderer and main process (implemented in preload). Types only. */

import type { AiEvent, AiRunResult, AiSettingsUpdate, AiSettingsView, AiTestResult, AiToolCall, AiToolOutcome } from "./ai.js";

export type MenuAction =
  | "new"
  | "open"
  | "save"
  | "saveAs"
  | "exportPng"
  | "saveAndClose"
  | "zoomIn"
  | "zoomOut"
  | "zoom100"
  | "zoomFit"
  | "toggleGrid"
  | "toggleSnap"
  | "simulateAiTurn";

export interface SaveResult {
  saved: boolean;
  name?: string;
}

export interface DesktopApi {
  platform: string;
  openFile(): Promise<{ name: string; text: string } | null>;
  save(text: string): Promise<SaveResult>;
  saveAs(text: string): Promise<SaveResult>;
  exportPng(bytes: Uint8Array): Promise<SaveResult>;
  newDocument(): void;
  setDirty(dirty: boolean): void;
  closeWindow(): void;
  onMenu(listener: (action: MenuAction) => void): void;
  ai: AiApi;
}

/** AI side chat. The API key goes in (settings) but never comes back out. */
export interface AiApi {
  getSettings(): Promise<AiSettingsView>;
  saveSettings(update: AiSettingsUpdate): Promise<AiSettingsView>;
  /** Tests the given (possibly unsaved) settings; a missing apiKey means the stored one. */
  test(update: AiSettingsUpdate): Promise<AiTestResult>;
  /** Models the configured endpoint offers; a missing apiKey means the stored one. */
  listModels(update: AiSettingsUpdate): Promise<{ ok: boolean; models: string[]; message?: string }>;
  /** Runs one user turn to completion; tool calls arrive through onToolCall meanwhile. */
  run(turnId: string, text: string): Promise<AiRunResult>;
  stop(): void;
  /** Forgets the conversation (the drawing is unaffected). */
  reset(): Promise<boolean>;
  onEvent(listener: (event: AiEvent) => void): void;
  onToolCall(listener: (call: AiToolCall) => void): void;
  sendToolResult(callId: string, outcome: AiToolOutcome): void;
}
