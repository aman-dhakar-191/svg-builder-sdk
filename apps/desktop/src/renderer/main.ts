import { defaultKeymap } from "@codemirror/commands";
import { xml } from "@codemirror/lang-xml";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { Annotation, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import type { NodeId } from "@svg-editor/model";
import { openSvg, type SourceDocument, type TextChange } from "@svg-editor/parser";
import { CanvasController, type Tool } from "./canvas.js";
import { selectionHighlight, setHighlights } from "./highlight.js";
import { SAMPLE } from "./sample.js";

const DEBOUNCE_MS = 150;

/** Marks code-pane changes that came from the model, so they are not sent back. */
const fromModel = Annotation.define<boolean>();

const opened = openSvg(SAMPLE);
if (!opened.ok) throw new Error(`sample SVG does not parse: ${opened.error.message}`);
const source: SourceDocument = opened.source;

const status = document.getElementById("status")!;

let pending: ReturnType<typeof setTimeout> | undefined;

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

/** Model changed (canvas gestures, undo/redo, code): patch the code pane, re-render. */
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
  canvas.render();
  highlight(canvas.getSelection());
  showSelectionStatus(canvas.getSelection());
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

const view = new EditorView({
  parent: document.getElementById("code")!,
  state: EditorState.create({
    doc: source.text,
    extensions: [
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
          return;
        }
        // Code cursor -> canvas selection (only when code and model agree).
        if (u.selectionSet && view.state.doc.toString() === source.text) {
          const id = source.nodeAt(u.state.selection.main.head);
          canvas.select(id === undefined || id === source.doc.root ? [] : [id]);
        }
      }),
      EditorView.theme({ "&": { fontSize: "13px" }, ".cm-scroller": { fontFamily: "ui-monospace, Menlo, Consolas, monospace" } }),
    ],
  }),
});

const toolbar = document.querySelector(".toolbar")!;
const canvas = new CanvasController(
  document.getElementById("canvas")!,
  document.getElementById("overlay") as unknown as SVGSVGElement,
  source,
  (ids) => {
    highlight(ids);
    showSelectionStatus(ids);
  },
  (tool: Tool) => {
    for (const b of toolbar.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
  },
);
toolbar.addEventListener("click", (e) => {
  const tool = (e.target as HTMLElement).closest("button")?.dataset.tool as Tool | undefined;
  if (tool) canvas.setTool(tool);
});

// Undo/redo anywhere in the window (CodeMirror handles its own keys first).
window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.target instanceof HTMLInputElement) return;
  const key = e.key.toLowerCase();
  if (key === "z" && !e.shiftKey) undo();
  else if ((key === "z" && e.shiftKey) || key === "y") redo();
  else return;
  e.preventDefault();
});

source.onChange(onModelChange);
canvas.setTool("select");
canvas.render();
showSelectionStatus([]);

// Exposed for end-to-end tests and debugging only.
(window as unknown as { editor: unknown }).editor = { source, view, flush, canvas };
