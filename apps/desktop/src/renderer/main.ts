import { defaultKeymap } from "@codemirror/commands";
import { xml } from "@codemirror/lang-xml";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { createEditor, EMPTY_SVG, SvgEditorError, type AbortSignalLike, type Editor, type LockInfo, type NodeId, type Rasterizer, type TextChangeEvent } from "@svg-editor/sdk";
import type { DesktopApi, MenuAction } from "../shared/api.js";
import { CanvasController, type Tool } from "./canvas.js";
import { ChatPanel } from "./chat.js";
import { selectionHighlight, setHighlights } from "./highlight.js";
import { LayersPanel } from "./layers.js";
import { PropertiesPanel } from "./properties.js";
import { SAMPLE } from "./sample.js";
import { Viewport } from "./viewport.js";

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

/*
 * The app is an SDK client: every document read and write below goes through
 * `editor` (@svg-editor/sdk), the same API scripts and the AI use. The UI adds
 * only view state (zoom, grid, tools) and DOM rendering.
 */

const DEBOUNCE_MS = 150;

/** Marks code-pane changes that came from the model, so they are not sent back. */
const fromModel = Annotation.define<boolean>();

const status = document.getElementById("status")!;
const zoomLabel = document.getElementById("zoom")!;
const toolbar = document.querySelector(".toolbar")!;
const lockBanner = document.getElementById("lock-banner")!;
/** Makes the code pane read-only while the document is locked. */
const editable = new Compartment();

/** Draws SVG text to PNG bytes in the browser: the SDK's rasterizer bridge. */
const rasterize: Rasterizer = async (svg, size) => {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image(size.width, size.height);
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("the drawing could not be rendered to an image"));
      img.src = url;
    });
    const c = document.createElement("canvas");
    c.width = size.width;
    c.height = size.height;
    c.getContext("2d")!.drawImage(img, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG encoding failed");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
};

let editor: Editor = openOrEmpty(SAMPLE);
/** Text as last opened or saved; differs from the code pane when there are unsaved changes. */
let savedText = SAMPLE;
/**
 * Line ending of the open file. The code pane (CodeMirror) and model work with
 * "\n"; files are converted on open and converted back on save, so a CRLF
 * file stays CRLF.
 */
let eol: "\n" | "\r\n" = "\n";
let lastDirty = false;
let pending: ReturnType<typeof setTimeout> | undefined;

function openOrEmpty(text: string): Editor {
  try {
    return createEditor({ svg: text, rasterize });
  } catch (e) {
    if (!(e instanceof SvgEditorError)) throw e;
    return createEditor({ svg: EMPTY_SVG, rasterize });
  }
}

// ------------------------------------------------------------ code -> model

/** Sends what is typed in the code pane to the model (code -> model -> canvas). */
function flush(): void {
  if (pending !== undefined) clearTimeout(pending);
  pending = undefined;
  const text = view.state.doc.toString();
  if (text === editor.text) return;
  try {
    editor.setText(text);
    view.dispatch(setDiagnostics(view.state, []));
  } catch (e) {
    if (e instanceof SvgEditorError && e.code === "LOCKED") {
      // Typed just as a lock started: the document belongs to the lock holder now.
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: editor.text }, annotations: fromModel.of(true) });
      showStatus("Your last code edit was not applied: the document is locked.", true);
      return;
    }
    if (!(e instanceof SvgEditorError) || !e.parse) throw e;
    // Keep the last good model and render; mark the error in the code pane.
    const from = Math.min(e.parse.offset, text.length);
    const to = Math.min(from + 1, text.length);
    view.dispatch(setDiagnostics(view.state, [{ from, to, severity: "error", message: `${e.message} ${e.hint}` }]));
    showStatus(e.message, true);
  }
}

// ------------------------------------------------------------ model -> views

/** Document changed (canvas, panels, undo/redo, code): patch the code pane, refresh the rest. */
function onDocumentChange(change: TextChangeEvent): void {
  if (change.origin !== "code") {
    view.dispatch({
      changes: change.edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
      annotations: fromModel.of(true),
    });
    if (view.state.doc.toString() !== change.text) {
      // Should not happen; resync rather than drift.
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: change.text }, annotations: fromModel.of(true) });
    }
    view.dispatch(setDiagnostics(view.state, []));
  }
  canvas.render();
  viewport.apply();
  canvas.refresh();
  layers.render();
  props.render();
  highlight(editor.getSelection());
  showSelectionStatus(editor.getSelection());
  updateDirty();
}

function onSelectionChange(ids: NodeId[]): void {
  layers.setSelection(ids);
  props.setSelection(ids);
  highlight(ids);
  showSelectionStatus(ids);
}

/**
 * Lock on: banner with Stop, canvas and panels inert, code pane read-only,
 * drawing tools off. The SDK enforces the lock; this only reflects it.
 */
function applyLock(info: LockInfo | null): void {
  const locked = info !== null;
  lockBanner.hidden = !locked;
  document.getElementById("lock-label")!.textContent = info?.label ?? "";
  document.body.classList.toggle("locked", locked);
  document.querySelector<HTMLElement>(".stage")!.inert = locked;
  document.querySelector<HTMLElement>(".design-panels")!.inert = locked;
  for (const b of toolbar.querySelectorAll<HTMLButtonElement>("[data-tool]")) b.disabled = locked;
  if (locked) canvas.interrupt();
  view.dispatch({ effects: editable.reconfigure(locked ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) });
}

/** Wires a (new) editor into every view. */
function attach(ed: Editor): void {
  ed.onChange(onDocumentChange);
  ed.onSelectionChange(onSelectionChange);
  ed.onLockChange(applyLock);
  ed.setBridges({ measure: (id) => canvas.measure(id) });
}

function showStatus(text: string, error: boolean): void {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function showSelectionStatus(ids: NodeId[]): void {
  if (ids.length === 0) showStatus(`${editor.doc.query().length - 1} elements`, false);
  else if (ids.length === 1) showStatus(`<${editor.doc.getNode(ids[0]!).tag}> ${ids[0]} selected`, false);
  else showStatus(`${ids.length} elements selected`, false);
}

/** Selection -> code pane: mark the nodes' source, scroll the first into view. */
function highlight(ids: NodeId[]): void {
  if (view.state.doc.toString() !== editor.text) return; // typing not flushed yet
  const ranges = ids.map((id) => editor.getSourceRange(id)).filter((r): r is { start: number; end: number } => r !== undefined);
  const effects = [setHighlights.of(ranges.map((r) => ({ from: r.start, to: r.end })))];
  const first = ranges[0];
  view.dispatch({
    effects: first && !view.hasFocus ? [...effects, EditorView.scrollIntoView(first.start, { y: "nearest" })] : effects,
    annotations: fromModel.of(true),
  });
}

function updateDirty(): void {
  const dirty = view.state.doc.toString() !== savedText;
  if (dirty === lastDirty) return;
  lastDirty = dirty;
  window.desktop?.setDirty(dirty);
}

// ------------------------------------------------------------------ history

function undo(): boolean {
  return guard(() => {
    flush();
    canvas.cancelGesture();
    editor.undo();
  });
}

function redo(): boolean {
  return guard(() => {
    flush();
    canvas.cancelGesture();
    editor.redo();
  });
}

/** Runs a document action; while locked, explains instead of failing silently. */
function guard(fn: () => void): true {
  if (editor.lockInfo) {
    showStatus(`${editor.lockInfo.label} Stop it first.`, true);
    return true;
  }
  fn();
  return true;
}

// -------------------------------------------------------------- lock demo

function sleep(ms: number, signal: AbortSignalLike): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

/**
 * Debug menu: a fake AI turn (timed edits under a lock) to try the lock,
 * Stop and single-step undo without any AI.
 */
async function simulateAiTurn(): Promise<void> {
  if (editor.lockInfo) return;
  flush();
  const ed = editor;
  const vb = (ed.doc.getNode(ed.doc.root).attrs.viewBox ?? "").split(/[\s,]+/).map(Number);
  const [x0, y0, w, h] = vb.length === 4 && vb.every(Number.isFinite) ? vb : [0, 0, ed.intrinsicSize().width, ed.intrinsicSize().height];
  const colors = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6"];
  try {
    await ed.runLocked({ reason: "simulation", label: "Simulated AI turn is drawing…", timeoutMs: 60_000 }, async (s) => {
      for (let i = 0; i < colors.length; i++) {
        await sleep(600, s.signal);
        s.doc.add("circle", { cx: x0! + (w! * (i + 1)) / 6, cy: y0! + h! / 2, r: Math.min(w!, h!) / 10, fill: colors[i]!, "fill-opacity": 0.85 });
      }
      await sleep(600, s.signal);
      s.doc.addText("Simulated AI turn", { x: x0! + w! / 12, y: y0! + h! * 0.85, "font-family": "sans-serif", "font-size": Math.min(w!, h!) / 12 });
    });
    showStatus("Simulated AI turn finished. One Ctrl+Z removes all of it.", false);
  } catch (e) {
    if (e instanceof SvgEditorError && e.code === "LOCK_STOPPED") return; // Stop already reported
    showStatus(e instanceof Error ? e.message : String(e), true);
  }
}

// -------------------------------------------------------------------- files

/** Loads a document: model, code pane, canvas and panels start fresh (history too). */
function load(fileText: string): void {
  if (pending !== undefined) clearTimeout(pending);
  pending = undefined;
  eol = fileText.includes("\r\n") ? "\r\n" : "\n";
  const text = fileText.replace(/\r\n/g, "\n");
  editor = openOrEmpty(text);
  attach(editor);
  view.setState(EditorState.create({ doc: text, extensions }));
  savedText = text;
  lastDirty = false;
  canvas.setEditor(editor);
  layers.setEditor(editor);
  props.setEditor(editor);
  viewport.apply();
  viewport.fit();
  onSelectionChange([]);
  if (text !== editor.text) flush(); // did not parse: show the error in the code pane
}

function confirmDiscard(): boolean {
  return !lastDirty || window.confirm("Discard unsaved changes?");
}

async function openFile(): Promise<void> {
  if (!confirmDiscard()) return;
  const file = await window.desktop.openFile();
  if (!file) return;
  load(file.text);
  if (text() === editor.text) showStatus(`Opened ${file.name}`, false);
}

async function save(as: boolean): Promise<boolean> {
  flush();
  const current = text();
  const out = eol === "\r\n" ? current.replace(/\n/g, "\r\n") : current;
  const r = as ? await window.desktop.saveAs(out) : await window.desktop.save(out);
  if (!r.saved) return false;
  savedText = current;
  lastDirty = false;
  showStatus(`Saved ${r.name}`, false);
  return true;
}

async function exportPng(): Promise<void> {
  flush();
  try {
    const r = await window.desktop.exportPng(await editor.exportPng());
    if (r.saved) showStatus(`Exported ${r.name}`, false);
  } catch (e) {
    showStatus(e instanceof Error ? e.message : String(e), true);
  }
}

function text(): string {
  return view.state.doc.toString();
}

// ------------------------------------------------------------------- views

const extensions: Extension[] = [
  lineNumbers(),
  highlightActiveLine(),
  drawSelection(),
  xml(),
  syntaxHighlighting(defaultHighlightStyle),
  lintGutter(),
  selectionHighlight,
  editable.of([]),
  // No CodeMirror history: the model owns undo for code and canvas alike.
  keymap.of([
    { key: "Mod-z", run: undo, preventDefault: true },
    { key: "Mod-Shift-z", run: redo, preventDefault: true },
    { key: "Mod-y", run: redo, preventDefault: true },
    ...defaultKeymap,
  ]),
  EditorView.updateListener.of((u) => {
    if (u.transactions.some((t) => t.annotation(fromModel))) return;
    if (u.docChanged) {
      if (pending !== undefined) clearTimeout(pending);
      pending = setTimeout(flush, DEBOUNCE_MS);
      updateDirty();
      return;
    }
    // Code cursor -> selection (only when code and model agree).
    if (u.selectionSet && u.view.state.doc.toString() === editor.text) {
      const id = editor.nodeAt(u.state.selection.main.head);
      editor.select(id === undefined || id === editor.doc.root ? [] : [id]);
    }
  }),
  EditorView.theme({ "&": { fontSize: "13px" }, ".cm-scroller": { fontFamily: "ui-monospace, Menlo, Consolas, monospace" } }),
];

const view = new EditorView({
  parent: document.getElementById("code")!,
  state: EditorState.create({ doc: editor.text, extensions }),
});

const canvasHost = document.getElementById("canvas")!;
const canvas = new CanvasController(canvasHost, document.getElementById("overlay") as unknown as SVGSVGElement, editor, (tool: Tool) => {
  for (const b of toolbar.querySelectorAll<HTMLButtonElement>("[data-tool]")) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
});

const viewport = new Viewport(canvasHost, document.getElementById("grid") as unknown as SVGSVGElement, () => {
  zoomLabel.textContent = `${Math.round(viewport.zoom * 100)}%`;
  toolbar.querySelector('[data-view="grid"]')!.setAttribute("aria-pressed", String(viewport.grid));
  toolbar.querySelector('[data-view="snap"]')!.setAttribute("aria-pressed", String(viewport.snapping));
  canvas.refresh();
});
canvas.snapper = viewport;
canvasHost.addEventListener("scroll", () => viewport.drawGrid());

const reportError = (message: string) => showStatus(message, true);
const layers = new LayersPanel(document.getElementById("layers")!, editor, reportError);
const props = new PropertiesPanel(document.getElementById("props")!, editor, reportError);

toolbar.addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest("button");
  if (!button) return;
  if (button.dataset.tool) canvas.setTool(button.dataset.tool as Tool);
  const action = button.dataset.view;
  if (action === "zoomIn") viewport.zoomIn();
  if (action === "zoomOut") viewport.zoomOut();
  if (action === "fit") viewport.fit();
  if (action === "grid") viewport.toggleGrid();
  if (action === "snap") viewport.toggleSnap();
});

// Undo/redo anywhere in the window (CodeMirror handles its own keys first).
window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const key = e.key.toLowerCase();
  if (key === "z" && !e.shiftKey) undo();
  else if ((key === "z" && e.shiftKey) || key === "y") redo();
  else return;
  e.preventDefault();
});

document.getElementById("lock-stop")!.addEventListener("click", () => {
  if (editor.stopLock({ keep: false })) showStatus("Stopped. The changes were discarded.", false);
});
document.getElementById("lock-keep")!.addEventListener("click", () => {
  const r = editor.stopLock({ keep: true });
  if (r) showStatus(r.changed ? "Stopped. The changes so far were kept (one Ctrl+Z removes them)." : "Stopped. Nothing had changed.", false);
});

const menu: Record<MenuAction, () => void> = {
  new: () =>
    guard(() => {
      if (!confirmDiscard()) return;
      load(EMPTY_SVG);
      window.desktop.newDocument();
    }),
  open: () => guard(() => void openFile()),
  save: () => guard(() => void save(false)),
  saveAs: () => guard(() => void save(true)),
  saveAndClose: () => guard(() => void save(false).then((ok) => ok && window.desktop.closeWindow())),
  exportPng: () => guard(() => void exportPng()),
  simulateAiTurn: () => void simulateAiTurn(),
  zoomIn: () => viewport.zoomIn(),
  zoomOut: () => viewport.zoomOut(),
  zoom100: () => viewport.setZoom(1),
  zoomFit: () => viewport.fit(),
  toggleGrid: () => viewport.toggleGrid(),
  toggleSnap: () => viewport.toggleSnap(),
};
window.desktop?.onMenu((action) => menu[action]?.());

// Sidebar tabs: Design (layers, properties) and AI (chat).
const tabs = [...document.querySelectorAll<HTMLButtonElement>(".tabs [data-tab]")];
function showTab(name: string): void {
  for (const t of tabs) {
    const on = t.dataset.tab === name;
    t.setAttribute("aria-selected", String(on));
    document.getElementById(`tab-${t.dataset.tab}`)!.hidden = !on;
  }
}
for (const t of tabs) t.addEventListener("click", () => showTab(t.dataset.tab!));

const chat = window.desktop ? new ChatPanel({ api: window.desktop.ai, editor: () => editor, flush, status: showStatus }) : null;

attach(editor);
canvas.setTool("select");
canvas.render();
viewport.apply();
layers.render();
props.render();
requestAnimationFrame(() => viewport.fit());
showSelectionStatus([]);

// Exposed for end-to-end tests and debugging only.
Object.defineProperty(window, "editor", {
  get: () => ({ editor, view, flush, canvas, viewport, menu, chat, showTab }),
});
