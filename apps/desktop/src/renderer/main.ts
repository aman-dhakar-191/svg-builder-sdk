import { defaultKeymap } from "@codemirror/commands";
import { xml } from "@codemirror/lang-xml";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { Annotation, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import type { NodeId } from "@svg-editor/model";
import { openSvg, type SourceDocument, type TextChange } from "@svg-editor/parser";
import type { DesktopApi, MenuAction } from "../shared/api.js";
import { CanvasController, type Tool } from "./canvas.js";
import { selectionHighlight, setHighlights } from "./highlight.js";
import { LayersPanel } from "./layers.js";
import { PropertiesPanel } from "./properties.js";
import { NEW_DOCUMENT, SAMPLE } from "./sample.js";
import { Viewport } from "./viewport.js";

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

const DEBOUNCE_MS = 150;

/** Marks code-pane changes that came from the model, so they are not sent back. */
const fromModel = Annotation.define<boolean>();

const status = document.getElementById("status")!;
const zoomLabel = document.getElementById("zoom")!;
const toolbar = document.querySelector(".toolbar")!;

let source: SourceDocument = openOrEmpty(SAMPLE);
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

function openOrEmpty(text: string): SourceDocument {
  const r = openSvg(text);
  if (r.ok) return r.source;
  const empty = openSvg(NEW_DOCUMENT);
  if (!empty.ok) throw new Error("internal: empty document does not parse");
  return empty.source;
}

// ------------------------------------------------------------ code -> model

/** Sends what is typed in the code pane to the model (code -> model -> canvas). */
function flush(): void {
  if (pending !== undefined) clearTimeout(pending);
  pending = undefined;
  const text = view.state.doc.toString();
  if (text === source.text) return;
  const r = source.setText(text);
  if (r.ok) {
    view.dispatch(setDiagnostics(view.state, []));
    return;
  }
  // Keep the last good model and render; mark the error in the code pane.
  const from = Math.min(r.error.offset, text.length);
  const to = Math.min(from + 1, text.length);
  view.dispatch(setDiagnostics(view.state, [{ from, to, severity: "error", message: `${r.error.message} ${r.error.hint}` }]));
  showStatus(`Line ${r.error.line}, column ${r.error.column}: ${r.error.message}`, true);
}

// ------------------------------------------------------------ model -> views

/** Model changed (canvas, panels, undo/redo, code): patch the code pane, refresh the rest. */
function onModelChange(change: TextChange): void {
  if (change.method !== "code") {
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
  refreshViews();
  showSelectionStatus(canvas.getSelection());
}

function refreshViews(): void {
  canvas.render();
  viewport.apply();
  canvas.refresh();
  layers.render();
  props.render();
  highlight(canvas.getSelection());
  updateDirty();
}

function onSelection(ids: NodeId[]): void {
  layers.setSelection(ids);
  props.setSelection(ids);
  highlight(ids);
  showSelectionStatus(ids);
}

function showStatus(text: string, error: boolean): void {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function showSelectionStatus(ids: NodeId[]): void {
  if (ids.length === 0) showStatus(`${source.doc.query().length - 1} elements`, false);
  else if (ids.length === 1) showStatus(`<${source.doc.getNode(ids[0]!)!.tag}> ${ids[0]} selected`, false);
  else showStatus(`${ids.length} elements selected`, false);
}

/** Canvas selection -> code pane: mark the nodes' source, scroll the first into view. */
function highlight(ids: NodeId[]): void {
  if (view.state.doc.toString() !== source.text) return; // typing not flushed yet
  const ranges = ids.map((id) => source.getSource(id)).filter((r): r is { start: number; end: number } => r !== undefined);
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
  flush();
  canvas.cancelGesture();
  source.doc.undo();
  return true;
}

function redo(): boolean {
  flush();
  canvas.cancelGesture();
  source.doc.redo();
  return true;
}

// -------------------------------------------------------------------- files

/** Loads a document: model, code pane, canvas and panels start fresh (history too). */
function load(fileText: string): void {
  if (pending !== undefined) clearTimeout(pending);
  pending = undefined;
  eol = fileText.includes("\r\n") ? "\r\n" : "\n";
  const text = fileText.replace(/\r\n/g, "\n");
  source = openOrEmpty(text);
  source.onChange(onModelChange);
  view.setState(EditorState.create({ doc: text, extensions }));
  savedText = text;
  lastDirty = false;
  canvas.setSource(source);
  layers.setDocument(source.doc);
  props.setDocument(source.doc);
  viewport.apply();
  viewport.fit();
  if (text !== source.text) flush(); // did not parse: show the error in the code pane
  else showSelectionStatus([]);
}

function confirmDiscard(): boolean {
  return !lastDirty || window.confirm("Discard unsaved changes?");
}

async function openFile(): Promise<void> {
  if (!confirmDiscard()) return;
  const file = await window.desktop.openFile();
  if (!file) return;
  load(file.text);
  if (text() === source.text) showStatus(`Opened ${file.name}`, false);
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
  const { width, height } = viewport.intrinsicSize();
  let svgText = source.doc.toSvg();
  if (!/^<svg[^>]*\sxmlns=/.test(svgText)) svgText = svgText.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  try {
    const img = new Image(width, height);
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("the drawing could not be rendered to an image"));
      img.src = url;
    });
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(width));
    c.height = Math.max(1, Math.round(height));
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG encoding failed");
    const r = await window.desktop.exportPng(new Uint8Array(await blob.arrayBuffer()));
    if (r.saved) showStatus(`Exported ${r.name}`, false);
  } catch (e) {
    showStatus(`Export failed: ${(e as Error).message}`, true);
  } finally {
    URL.revokeObjectURL(url);
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
    // Code cursor -> canvas selection (only when code and model agree).
    if (u.selectionSet && u.view.state.doc.toString() === source.text) {
      const id = source.nodeAt(u.state.selection.main.head);
      canvas.select(id === undefined || id === source.doc.root ? [] : [id]);
    }
  }),
  EditorView.theme({ "&": { fontSize: "13px" }, ".cm-scroller": { fontFamily: "ui-monospace, Menlo, Consolas, monospace" } }),
];

const view = new EditorView({
  parent: document.getElementById("code")!,
  state: EditorState.create({ doc: source.text, extensions }),
});

const canvasHost = document.getElementById("canvas")!;
const canvas = new CanvasController(canvasHost, document.getElementById("overlay") as unknown as SVGSVGElement, source, onSelection, (tool: Tool) => {
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
const layers = new LayersPanel(document.getElementById("layers")!, source.doc, (ids) => canvas.select(ids), reportError);
const props = new PropertiesPanel(document.getElementById("props")!, source.doc, reportError);

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

const menu: Record<MenuAction, () => void> = {
  new: () => {
    if (!confirmDiscard()) return;
    load(NEW_DOCUMENT);
    window.desktop.newDocument();
  },
  open: () => void openFile(),
  save: () => void save(false),
  saveAs: () => void save(true),
  saveAndClose: () => void save(false).then((ok) => ok && window.desktop.closeWindow()),
  exportPng: () => void exportPng(),
  zoomIn: () => viewport.zoomIn(),
  zoomOut: () => viewport.zoomOut(),
  zoom100: () => viewport.setZoom(1),
  zoomFit: () => viewport.fit(),
  toggleGrid: () => viewport.toggleGrid(),
  toggleSnap: () => viewport.toggleSnap(),
};
window.desktop?.onMenu((action) => menu[action]?.());

source.onChange(onModelChange);
canvas.setTool("select");
canvas.render();
viewport.apply();
layers.render();
props.render();
requestAnimationFrame(() => viewport.fit());
showSelectionStatus([]);

// Exposed for end-to-end tests and debugging only.
Object.defineProperty(window, "editor", {
  get: () => ({ source, view, flush, canvas, viewport, menu }),
});
