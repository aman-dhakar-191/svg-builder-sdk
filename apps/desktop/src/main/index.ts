import { app, BrowserWindow, Menu, shell } from "electron";
import { join } from "node:path";

// Secure defaults: no Node in the renderer, isolated preload, sandboxed,
// no navigation away from the app and no new windows.
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "SVG Editor",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
}

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

void app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "fileMenu" },
      // Undo/redo belong to the document model, handled in the renderer.
      { label: "Edit", submenu: [{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
