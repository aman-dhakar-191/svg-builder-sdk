/** The bridge between renderer and main process (implemented in preload). Types only. */

import type { AiEvent, AiRunResult, AiSettingsUpdate, AiSettingsView, AiTestResult, AiToolCall, AiToolOutcome } from "./ai.js";

export type MenuAction =
  | "new"
  | "open"
  | "save"
  | "saveAs"
  | "export"
  | "exportPng"
  | "saveAndClose"
  | "zoomIn"
  | "zoomOut"
  | "zoom100"
  | "zoomFit"
  | "toggleGrid"
  | "toggleSnap"
  | "simulateAiTurn"
  | "convertToPath"
  | "editNodes"
  | "union"
  | "subtract"
  | "intersect"
  | "exclude"
  | "simplify"
  | "undo"
  | "redo"
  | "toggleMode"
  | "commandPalette"
  | "settings"
  | "startScreen";

export interface RecentFile {
  id: number;
  name: string;
  /** Containing folder name, to tell same-named files apart. */
  folder: string;
  openedAt: number;
}

export interface SaveResult {
  saved: boolean;
  name?: string;
  /** Why nothing was written, when the user should be told. */
  error?: string;
}

/** SVG export styles: re-indented, or with no whitespace between tags. */
export type SvgExportStyle = "formatted" | "minified";

export interface DesktopApi {
  platform: string;
  openFile(): Promise<{ name: string; text: string } | null>;
  save(text: string): Promise<SaveResult>;
  saveAs(text: string): Promise<SaveResult>;
  exportPng(bytes: Uint8Array): Promise<SaveResult>;
  /** Writes a copy; the open file and its path are unchanged. */
  exportSvg(text: string, style: SvgExportStyle): Promise<SaveResult>;
  newDocument(): void;
  setDirty(dirty: boolean): void;
  closeWindow(): void;
  onMenu(listener: (action: MenuAction) => void): void;
  /** Recently opened files, newest first. Paths stay in the main process; the renderer gets names and ids. */
  recentFiles(): Promise<RecentFile[]>;
  /** Opens a recent file by id; null if it no longer exists. */
  openRecent(id: number): Promise<{ name: string; text: string } | null>;
  /** Colours of the window buttons drawn over the custom title bar. */
  setTitleBarTheme(theme: "light" | "dark"): void;
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
