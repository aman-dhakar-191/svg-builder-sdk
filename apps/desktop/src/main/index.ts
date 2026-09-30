import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { registerAiIpc } from "./ai/index.js";

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
  win.setTitle(`${s.dirty ? "• " : ""}${name} — SVG Editor`);
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
  s.path = path;
  s.dirty = false;
  updateTitle(win);
  return { saved: true, name: basename(path) };
}

ipcMain.handle("file:open", async (e) => {
  const win = senderWindow(e);
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: SVG_FILTER });
  if (r.canceled || !r.filePaths[0]) return null;
  const path = r.filePaths[0];
  const text = await readFile(path, "utf8");
  const s = stateOf(win);
  s.path = path;
  s.dirty = false;
  updateTitle(win);
  return { name: basename(path), text };
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

/** Menu items only forward to the renderer, which owns the document. */
function send(action: string) {
  return (_item: Electron.MenuItem, win: Electron.BaseWindow | undefined): void => {
    if (win instanceof BrowserWindow) win.webContents.send("menu", action);
  };
}

function buildMenu(): void {
  const file: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      { label: "New", accelerator: "CmdOrCtrl+N", click: send("new") },
      { label: "Open…", accelerator: "CmdOrCtrl+O", click: send("open") },
      { type: "separator" },
      { label: "Save", accelerator: "CmdOrCtrl+S", click: send("save") },
      { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: send("saveAs") },
      { label: "Export PNG…", click: send("exportPng") },
      { type: "separator" },
      { role: "quit" },
    ],
  };
  const view: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: send("zoomIn") },
      { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: send("zoomOut") },
      { label: "Actual Size", accelerator: "CmdOrCtrl+1", click: send("zoom100") },
      { label: "Fit", accelerator: "CmdOrCtrl+0", click: send("zoomFit") },
      { type: "separator" },
      { label: "Show Grid", accelerator: "CmdOrCtrl+'", click: send("toggleGrid") },
      { label: "Snap to Grid", accelerator: "CmdOrCtrl+Shift+'", click: send("toggleSnap") },
      { type: "separator" },
      { role: "toggleDevTools" },
    ],
  };
  const debug: MenuItemConstructorOptions = {
    label: "Debug",
    submenu: [{ label: "Simulate AI Turn (tests the editor lock)", click: send("simulateAiTurn") }],
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
      file,
      // Undo/redo belong to the document model, handled in the renderer.
      { label: "Edit", submenu: [{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
      view,
      debug,
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
    title: "SVG Editor",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  updateTitle(win);
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
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
