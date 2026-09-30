import { contextBridge } from "electron";

// The only surface the renderer gets from Electron. File access, menus and
// (Phase 2) AI calls are added here as narrow, typed functions.
const api = {
  platform: process.platform,
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld("desktop", api);
