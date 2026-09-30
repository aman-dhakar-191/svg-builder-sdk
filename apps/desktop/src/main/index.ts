import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { registerAiIpc } from "./ai/index.js";
import { checkOnStart, registerUpdater } from "./updater.js";

// Tests point userData at a temp dir so settings never touch the real profile.
if (process.env.SVG_EDITOR_USER_DATA) app.setPath("userData", process.env.SVG_EDITOR_USER_DATA);

/**
 * Per-window file state lives here, not in the renderer: the renderer never
 * sends a path, so it can only write where the user picked in a dialog.
 */
interface WindowState {
  path: string | null;
  dirty: boolean;
  /** Set once the user confirmed closing (or there was nothing to save). */
  closing: boolean;
}

const state = new WeakMap<BrowserWindow, WindowState>();
const SVG_FILTER = [{ name: "SVG", extensions: ["svg"] }];

function stateOf(win: BrowserWindow): WindowState {
  let s = state.get(win);
  if (!s) {
    s = { path: null, dirty: false, closing: false };
    state.set(win, s);
  }
  return s;
}

function updateTitle(win: BrowserWindow): void {
  const s = stateOf(win);
  const name = s.path ? basename(s.path) : "Untitled.svg";
  win.setTitle(`${s.dirty ? "• " : ""}${name} — Curvant`);
}

function senderWindow(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) throw new Error("no window for sender");
  return win;
}

async function saveTo(win: BrowserWindow, text: string, askPath: boolean): Promise<{ saved: boolean; name?: string }> {
  if (typeof text !== "string") throw new Error("save: text must be a string");
  const s = stateOf(win);
  let path = s.path;
  if (askPath || !path) {
    const r = await dialog.showSaveDialog(win, { defaultPath: path ?? "Untitled.svg", filters: SVG_FILTER });
    if (r.canceled || !r.filePath) return { saved: false };
    path = r.filePath;
  }
  await writeFile(path, text, "utf8");
  void rememberRecent(path);
  s.path = path;
  s.dirty = false;
  updateTitle(win);
  return { saved: true, name: basename(path) };
}

async function openPath(win: BrowserWindow, path: string): Promise<{ name: string; text: string }> {
  const text = await readFile(path, "utf8");
  const s = stateOf(win);
  s.path = path;
  s.dirty = false;
  updateTitle(win);
  void rememberRecent(path);
  return { name: basename(path), text };
}

ipcMain.handle("file:open", async (e) => {
  const win = senderWindow(e);
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: SVG_FILTER });
  if (r.canceled || !r.filePaths[0]) return null;
  return openPath(win, r.filePaths[0]);
});

// ------------------------------------------------------------ recent files
// Paths stay here: the renderer gets names and ids, and opens by id.

interface Recent {
  path: string;
  openedAt: number;
}
const RECENT_MAX = 8;
const recentFile = () => join(app.getPath("userData"), "recent.json");
let recentIds = new Map<number, string>();

async function loadRecent(): Promise<Recent[]> {
  try {
    const list = JSON.parse(await readFile(recentFile(), "utf8")) as Recent[];
    return Array.isArray(list) ? list.filter((r) => typeof r.path === "string" && typeof r.openedAt === "number") : [];
  } catch {
    return [];
  }
}

async function rememberRecent(path: string): Promise<void> {
  const list = (await loadRecent()).filter((r) => r.path !== path);
  list.unshift({ path, openedAt: Date.now() });
  await writeFile(recentFile(), JSON.stringify(list.slice(0, RECENT_MAX)), "utf8").catch(() => {});
}

ipcMain.handle("file:recent", async () => {
  const list = await loadRecent();
  recentIds = new Map(list.map((r, i) => [i + 1, r.path]));
  return list.map((r, i) => ({ id: i + 1, name: basename(r.path), folder: basename(dirname(r.path)), openedAt: r.openedAt }));
});

ipcMain.handle("file:openRecent", async (e, id: unknown) => {
  const path = typeof id === "number" ? recentIds.get(id) : undefined;
  if (!path) return null;
  try {
    return await openPath(senderWindow(e), path);
  } catch {
    return null; // moved or deleted
  }
});

// ------------------------------------------------------------ title bar

/** Window buttons drawn over the custom title bar (Windows, Linux); colours follow the app theme. */
const TITLE_BAR = { light: { color: "#ffffff", symbolColor: "#15161f" }, dark: { color: "#14151f", symbolColor: "#e6e7f0" } };
const TITLE_BAR_HEIGHT = 44;

ipcMain.on("window:titleBarTheme", (e, theme: unknown) => {
  if (process.platform === "darwin" || (theme !== "light" && theme !== "dark")) return;
  const win = BrowserWindow.fromWebContents(e.sender);
  win?.setTitleBarOverlay({ ...TITLE_BAR[theme], height: TITLE_BAR_HEIGHT });
});

ipcMain.handle("file:save", (e, text: string) => saveTo(senderWindow(e), text, false));
ipcMain.handle("file:saveAs", (e, text: string) => saveTo(senderWindow(e), text, true));

ipcMain.handle("file:exportPng", async (e, bytes: Uint8Array) => {
  const win = senderWindow(e);
  if (!(bytes instanceof Uint8Array)) throw new Error("exportPng: expected bytes");
  const base = stateOf(win).path?.replace(/\.svg$/i, "") ?? "Untitled";
  const r = await dialog.showSaveDialog(win, { defaultPath: `${base}.png`, filters: [{ name: "PNG", extensions: ["png"] }] });
  if (r.canceled || !r.filePath) return { saved: false };
  await writeFile(r.filePath, bytes);
  return { saved: true, name: basename(r.filePath) };
});

ipcMain.handle("file:exportSvg", async (e, text: unknown, style: unknown) => {
  const win = senderWindow(e);
  if (typeof text !== "string" || (style !== "formatted" && style !== "minified")) throw new Error("exportSvg: bad arguments");
  const open = stateOf(win).path;
  const base = open?.replace(/\.svg$/i, "") ?? "Untitled";
  const r = await dialog.showSaveDialog(win, { defaultPath: `${base}.${style === "minified" ? "min" : "formatted"}.svg`, filters: SVG_FILTER });
  if (r.canceled || !r.filePath) return { saved: false };
  // Writing over the open file would leave the editor showing text that is no longer on disk.
  if (open && resolve(r.filePath) === resolve(open)) return { saved: false, error: "That is the open file. Export to another name, or use Save." };
  await writeFile(r.filePath, text, "utf8");
  return { saved: true, name: basename(r.filePath) };
});

ipcMain.on("doc:dirty", (e, dirty: boolean) => {
  const win = senderWindow(e);
  stateOf(win).dirty = dirty === true;
  updateTitle(win);
});

ipcMain.on("doc:new", (e) => {
  const win = senderWindow(e);
  const s = stateOf(win);
  s.path = null;
  s.dirty = false;
  updateTitle(win);
});

ipcMain.on("window:close", (e) => {
  const win = senderWindow(e);
  stateOf(win).closing = true;
  win.close();
});

/**
 * Menu items only forward to the renderer, which owns the document. The
 * renderer also owns keyboard shortcuts (one place, every platform, also with
 * the custom title bar); menus only display them.
 */
function item(label: string, action: string, accelerator?: string): MenuItemConstructorOptions {
  return { label, click: send(action), ...(accelerator ? { accelerator, registerAccelerator: false } : {}) };
}

function send(action: string) {
  return (_item: Electron.MenuItem, win: Electron.BaseWindow | undefined): void => {
    if (win instanceof BrowserWindow) win.webContents.send("menu", action);
  };
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
      {
        label: "File",
        submenu: [
          item("New", "new", "CmdOrCtrl+N"),
          item("Open…", "open", "CmdOrCtrl+O"),
          item("Open Recent…", "startScreen"),
          { type: "separator" },
          item("Save", "save", "CmdOrCtrl+S"),
          item("Save As…", "saveAs", "CmdOrCtrl+Shift+S"),
          item("Export…", "export", "CmdOrCtrl+Shift+E"),
          item("Export PNG…", "exportPng"),
          { type: "separator" },
          item("Settings…", "settings", "CmdOrCtrl+,"),
          // No updates on macOS (unsigned builds).
          ...(process.platform === "darwin" ? [] : [item("Check for Updates…", "checkUpdates")]),
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          // Undo/redo belong to the document model.
          item("Undo", "undo", "CmdOrCtrl+Z"),
          item("Redo", "redo", "CmdOrCtrl+Shift+Z"),
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "Path",
        submenu: [
          item("Convert to Path", "convertToPath", "CmdOrCtrl+Shift+C"),
          item("Edit Path Nodes", "editNodes"),
          { type: "separator" },
          // Bottom to top in the stacking order, like Inkscape; no shortcuts (Ctrl +/- zoom).
          item("Union", "union"),
          item("Subtract (bottom minus the others)", "subtract"),
          item("Intersect", "intersect"),
          item("Exclude", "exclude"),
          { type: "separator" },
          item("Simplify", "simplify", "CmdOrCtrl+L"),
        ],
      },
      {
        label: "View",
        submenu: [
          item("Editor / Agent", "toggleMode", "CmdOrCtrl+E"),
          item("Command Palette…", "commandPalette", "CmdOrCtrl+K"),
          { type: "separator" },
          item("Zoom In", "zoomIn", "CmdOrCtrl+="),
          item("Zoom Out", "zoomOut", "CmdOrCtrl+-"),
          item("Actual Size", "zoom100", "CmdOrCtrl+1"),
          item("Fit", "zoomFit", "CmdOrCtrl+0"),
          { type: "separator" },
          item("Show Grid", "toggleGrid", "CmdOrCtrl+'"),
          item("Snap to Grid", "toggleSnap", "CmdOrCtrl+Shift+'"),
          item("Snap to Shapes", "toggleSnapShapes"),
          { type: "separator" },
          { role: "toggleDevTools" },
        ],
      },
      { label: "Debug", submenu: [item("Simulate AI Turn (tests the editor lock)", "simulateAiTurn")] },
      { role: "windowMenu" },
    ]),
  );
}

// Secure defaults: no Node in the renderer, isolated preload, sandboxed,
// no navigation away from the app and no new windows.
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    title: "Curvant",
    // The app draws its own title bar (menus, Editor/Agent switch); the OS draws the window buttons over it.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { titleBarOverlay: { ...TITLE_BAR.light, height: TITLE_BAR_HEIGHT } }),
    backgroundColor: "#eff0f5",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  updateTitle(win);
  win.once("ready-to-show", () => win.show()); // no white flash before the first paint
  win.on("page-title-updated", (e) => e.preventDefault());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  win.on("close", (event) => {
    const s = stateOf(win);
    if (!s.dirty || s.closing) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Save", "Don't Save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: "Save changes before closing?",
    });
    if (choice === 1) {
      s.closing = true;
      win.close();
    } else if (choice === 0) {
      // The renderer has the text: it saves, then asks to close.
      win.webContents.send("menu", "saveAndClose");
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
}

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

void app.whenReady().then(() => {
  registerAiIpc();
  registerUpdater();
  buildMenu();
  createWindow();
  checkOnStart();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
