import { defaultKeymap } from "@codemirror/commands";
import { xml } from "@codemirror/lang-xml";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { Annotation, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { openSvg, type SourceDocument, type TextChange } from "@svg-editor/parser";
import { renderTree } from "./render.js";
import { SAMPLE } from "./sample.js";

const DEBOUNCE_MS = 150;

/** Marks code-pane changes that came from the model, so they are not sent back. */
const fromModel = Annotation.define<boolean>();

const opened = openSvg(SAMPLE);
if (!opened.ok) throw new Error(`sample SVG does not parse: ${opened.error.message}`);
const source: SourceDocument = opened.source;

const canvas = document.getElementById("canvas")!;
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

/** Model changed (undo/redo, later canvas and SDK edits): patch the code pane, re-render. */
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
  render();
}

function render(): void {
  const { svg } = renderTree(source.doc.getTree()!);
  canvas.replaceChildren(svg);
  showStatus(`${source.doc.query().length - 1} elements`, false);
}

function showStatus(text: string, error: boolean): void {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function undo(): boolean {
  flush();
  source.doc.undo();
  return true;
}

function redo(): boolean {
  flush();
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
      // No CodeMirror history: the model owns undo for code and canvas alike.
      keymap.of([
        { key: "Mod-z", run: undo, preventDefault: true },
        { key: "Mod-Shift-z", run: redo, preventDefault: true },
        { key: "Mod-y", run: redo, preventDefault: true },
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || u.transactions.some((t) => t.annotation(fromModel))) return;
        if (pending !== undefined) clearTimeout(pending);
        pending = setTimeout(flush, DEBOUNCE_MS);
      }),
      EditorView.theme({ "&": { fontSize: "13px" }, ".cm-scroller": { fontFamily: "ui-monospace, Menlo, Consolas, monospace" } }),
    ],
  }),
});

source.onChange(onModelChange);
render();

// Exposed for end-to-end tests and debugging only.
(window as unknown as { editor: unknown }).editor = { source, view, flush };
