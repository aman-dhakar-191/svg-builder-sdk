import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UpdateState } from "../shared/api.js";

/*
 * Updates from GitHub Releases (the repository is public, so no token): check, download in the
 * background, install on "Restart to update" or when the app quits. Windows (the per-user NSIS
 * installer, run silently) and Linux (AppImage) only; macOS builds are unsigned, and macOS only
 * installs signed updates, so macOS is not offered updates at all.
 */

let state: UpdateState = { state: "idle" };
let started = false;

function send(next: UpdateState): void {
  state = next;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("update:state", state);
}

/** Why updates cannot run in this build, or null when they can. */
function unsupported(): string | null {
  if (process.platform === "darwin") return "Updates are not offered on macOS: download new versions from the releases page.";
  if (!app.isPackaged && !process.env.SVG_EDITOR_UPDATE_URL) return "Updates only work in the installed app.";
  if (!autoUpdater.isUpdaterActive()) return "Updates only work in the installed app (the Windows installer or the AppImage).";
  return null;
}

const settingsFile = () => join(app.getPath("userData"), "update-settings.json");

async function autoCheck(): Promise<boolean> {
  try {
    return (JSON.parse(await readFile(settingsFile(), "utf8")) as { autoCheck?: unknown }).autoCheck !== false;
  } catch {
    return true;
  }
}

/** A short message for the status bar: the first line, without a stack or HTTP dump. */
function short(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.trim();
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR_/.test(text)) return "Could not reach GitHub to check for updates.";
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

async function check(): Promise<void> {
  const why = unsupported();
  if (why) return send({ state: "unsupported", message: why });
  if (state.state === "checking" || state.state === "downloading" || state.state === "ready") return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    send({ state: "error", message: short(e) });
  }
}

export function registerUpdater(): void {
  // Test hook: a local feed instead of GitHub (e2e). It only checks; it does not download.
  const testFeed = process.env.SVG_EDITOR_UPDATE_URL;
  if (testFeed) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.autoDownload = false;
    try {
      autoUpdater.setFeedURL({ provider: "generic", url: testFeed });
    } catch (e) {
      console.warn("SVG_EDITOR_UPDATE_URL ignored:", e);
    }
  } else {
    autoUpdater.autoDownload = true;
  }
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => send({ state: "checking" }));
  autoUpdater.on("update-not-available", () => send({ state: "none", version: app.getVersion() }));
  autoUpdater.on("update-available", (info) => send(autoUpdater.autoDownload ? { state: "downloading", version: info.version, percent: 0 } : { state: "available", version: info.version }));
  autoUpdater.on("download-progress", (p) => {
    if (state.state === "downloading") send({ ...state, percent: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => send({ state: "ready", version: info.version }));
  autoUpdater.on("error", (e) => send({ state: "error", message: short(e) }));

  ipcMain.handle("update:get", async () => ({ current: app.getVersion(), state, autoCheck: await autoCheck(), supported: unsupported() === null }));
  ipcMain.on("update:check", () => void check());
  ipcMain.handle("update:setAutoCheck", async (_e, on: unknown) => {
    if (typeof on !== "boolean") throw new Error("setAutoCheck: expected a boolean");
    await writeFile(settingsFile(), JSON.stringify({ autoCheck: on }), "utf8");
  });
  ipcMain.on("update:install", () => {
    if (state.state !== "ready") return;
    // Silent install (the per-user installer needs no questions), then start the new version.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });
}

/** The quiet check a few seconds after start, when automatic checks are on. */
export function checkOnStart(): void {
  if (started) return;
  started = true;
  setTimeout(() => {
    void autoCheck().then((on) => {
      if (on && unsupported() === null) void check();
    });
  }, 4000);
}
