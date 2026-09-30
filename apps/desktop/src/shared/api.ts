/** The bridge between renderer and main process (implemented in preload). Types only. */

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
}
