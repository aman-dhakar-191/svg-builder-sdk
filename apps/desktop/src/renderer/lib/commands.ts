import type { MenuAction } from "../../shared/api.js";

/**
 * One list of user commands: the title-bar menus, the command palette and the
 * keyboard handler all read it, so a shortcut shown anywhere is the one that works.
 */
export interface Command {
  action: MenuAction;
  label: string;
  menu: "File" | "Edit" | "Path" | "View";
  /** Display form; "Mod" is Ctrl (Cmd on macOS). */
  keys?: string;
  /** Extra words the palette matches. */
  keywords?: string;
  /** Starts a new group in its menu. */
  separator?: boolean;
}

export const COMMANDS: Command[] = [
  { action: "new", label: "New drawing", menu: "File", keys: "Mod+N" },
  { action: "open", label: "Open…", menu: "File", keys: "Mod+O" },
  { action: "startScreen", label: "Open recent…", menu: "File", keywords: "start recent files" },
  { action: "save", label: "Save", menu: "File", keys: "Mod+S", separator: true },
  { action: "saveAs", label: "Save as…", menu: "File", keys: "Mod+Shift+S" },
  { action: "export", label: "Export…", menu: "File", keys: "Mod+Shift+E", keywords: "svg png minify minified formatted pretty print image" },
  { action: "exportPng", label: "Export PNG…", menu: "File", keywords: "image picture" },
  { action: "settings", label: "Settings…", menu: "File", keys: "Mod+,", separator: true, keywords: "preferences ai model api key theme" },

  { action: "undo", label: "Undo", menu: "Edit", keys: "Mod+Z" },
  { action: "redo", label: "Redo", menu: "Edit", keys: "Mod+Shift+Z" },

  { action: "convertToPath", label: "Convert to path", menu: "Path", keys: "Mod+Shift+C" },
  { action: "editNodes", label: "Edit path nodes", menu: "Path", keywords: "points handles bezier" },
  { action: "union", label: "Union", menu: "Path", separator: true, keywords: "combine merge boolean" },
  { action: "subtract", label: "Subtract (bottom minus the others)", menu: "Path", keywords: "difference minus boolean cut" },
  { action: "intersect", label: "Intersect", menu: "Path", keywords: "boolean overlap" },
  { action: "exclude", label: "Exclude", menu: "Path", keywords: "xor boolean" },
  { action: "simplify", label: "Simplify", menu: "Path", keys: "Mod+L", separator: true, keywords: "fewer points smooth" },

  { action: "toggleMode", label: "Switch Editor / Agent", menu: "View", keys: "Mod+E", keywords: "ai chat mode" },
  { action: "commandPalette", label: "Command palette", menu: "View", keys: "Mod+K", keywords: "search actions" },
  { action: "zoomIn", label: "Zoom in", menu: "View", keys: "Mod+=", separator: true },
  { action: "zoomOut", label: "Zoom out", menu: "View", keys: "Mod+-" },
  { action: "zoom100", label: "Actual size", menu: "View", keys: "Mod+1", keywords: "100%" },
  { action: "zoomFit", label: "Zoom to fit", menu: "View", keys: "Mod+0" },
  { action: "toggleGrid", label: "Show grid", menu: "View", keys: "Mod+'", separator: true },
  { action: "toggleSnap", label: "Snap to grid", menu: "View", keys: "Mod+Shift+'" },
  { action: "toggleSnapShapes", label: "Snap to shapes", menu: "View", keywords: "smart guides align edges centres centers objects" },
];

export const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** "Mod+Shift+S" -> "Ctrl+Shift+S" (or "⌘⇧S" on macOS). */
export function formatKeys(keys: string): string {
  if (!IS_MAC) return keys.replace("Mod", "Ctrl");
  return keys.replace("Mod+", "⌘").replace("Shift+", "⇧").replace("Alt+", "⌥");
}

/** The command a key press triggers, if any. */
export function commandForKey(e: KeyboardEvent): MenuAction | null {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return null;
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  // Shift changes the character on some keys; normalise the ones we use.
  if (key === "+") key = "=";
  if (key === '"') key = "'";
  if (key === "Y" && !e.shiftKey) return "redo";
  const combo = `Mod+${e.shiftKey ? "Shift+" : ""}${key}`;
  return COMMANDS.find((c) => c.keys === combo)?.action ?? null;
}
