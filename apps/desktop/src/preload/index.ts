import { contextBridge, ipcRenderer } from "electron";
import type { AiEvent, AiToolCall, AiToolOutcome, AiSettingsUpdate } from "../shared/ai.js";
import type { DesktopApi, MenuAction, SaveResult, SvgExportStyle, UpdateState } from "../shared/api.js";

// The only surface the renderer gets from Electron: narrow, typed functions.
// No paths cross this bridge; the main process remembers the file per window.
const api: DesktopApi = {
  platform: process.platform,
  openFile: (): Promise<{ name: string; text: string } | null> => ipcRenderer.invoke("file:open"),
  save: (text: string): Promise<SaveResult> => ipcRenderer.invoke("file:save", text),
  saveAs: (text: string): Promise<SaveResult> => ipcRenderer.invoke("file:saveAs", text),
  exportPng: (bytes: Uint8Array): Promise<SaveResult> => ipcRenderer.invoke("file:exportPng", bytes),
  exportSvg: (text: string, style: SvgExportStyle): Promise<SaveResult> => ipcRenderer.invoke("file:exportSvg", text, style),
  newDocument: (): void => ipcRenderer.send("doc:new"),
  setDirty: (dirty: boolean): void => ipcRenderer.send("doc:dirty", dirty),
  closeWindow: (): void => ipcRenderer.send("window:close"),
  onMenu: (listener: (action: MenuAction) => void): void => {
    ipcRenderer.on("menu", (_e, action: MenuAction) => listener(action));
  },
  recentFiles: () => ipcRenderer.invoke("file:recent"),
  openRecent: (id: number) => ipcRenderer.invoke("file:openRecent", id),
  setTitleBarTheme: (theme: "light" | "dark") => ipcRenderer.send("window:titleBarTheme", theme),
  ai: {
    getSettings: () => ipcRenderer.invoke("ai:getSettings"),
    saveSettings: (update: AiSettingsUpdate) => ipcRenderer.invoke("ai:saveSettings", update),
    test: (update: AiSettingsUpdate) => ipcRenderer.invoke("ai:test", update),
    listModels: (update: AiSettingsUpdate) => ipcRenderer.invoke("ai:listModels", update),
    run: (turnId: string, text: string) => ipcRenderer.invoke("ai:run", turnId, text),
    stop: () => ipcRenderer.send("ai:stop"),
    reset: () => ipcRenderer.invoke("ai:reset"),
    onEvent: (listener: (event: AiEvent) => void) => {
      ipcRenderer.on("ai:event", (_e, event: AiEvent) => listener(event));
    },
    onToolCall: (listener: (call: AiToolCall) => void) => {
      ipcRenderer.on("ai:toolCall", (_e, call: AiToolCall) => listener(call));
    },
    sendToolResult: (callId: string, outcome: AiToolOutcome) => ipcRenderer.send("ai:toolResult", callId, outcome),
  },
  update: {
    get: () => ipcRenderer.invoke("update:get"),
    check: () => ipcRenderer.send("update:check"),
    setAutoCheck: (on: boolean) => ipcRenderer.invoke("update:setAutoCheck", on),
    install: () => ipcRenderer.send("update:install"),
    onState: (listener: (state: UpdateState) => void) => {
      ipcRenderer.on("update:state", (_e, state: UpdateState) => listener(state));
    },
  },
};

contextBridge.exposeInMainWorld("desktop", api);
