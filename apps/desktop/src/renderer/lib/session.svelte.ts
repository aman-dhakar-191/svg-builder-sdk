import { defaultKeymap } from "@codemirror/commands";
import { xml } from "@codemirror/lang-xml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { createEditor, EMPTY_SVG, SvgEditorError, type AbortSignalLike, type Editor, type LockInfo, type NodeId, type Rasterizer, type TextChangeEvent } from "@svg-editor/sdk";
import type { DesktopApi, MenuAction, SvgExportStyle, UpdateState } from "../../shared/api.js";
import { CanvasController, type Tool } from "../canvas.js";
import { selectionHighlight, setHighlights } from "../highlight.js";
import { SAMPLE } from "../sample.js";
import { numberAt, scrubbed, type ScrubNumber } from "../scrub.js";
import { Viewport } from "../viewport.js";
import { reducedMotion } from "./motion.js";

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

/*
 * The app is an SDK client: every document read and write goes through
 * `editor` (@svg-editor/sdk), the same API scripts and the AI use. This store
 * wires the editor to the code view (CodeMirror) and the canvas engine, and
 * exposes what the Svelte components show as reactive state.
 */

export type Mode = "editor" | "agent";
export type Theme = "system" | "light" | "dark";
export type Overlay = "palette" | "settings" | "start" | "export" | null;
export interface Status {
  text: string;
  error: boolean;
  /** Changes on every message, so the same text twice still animates. */
  id: number;
}

const DEBOUNCE_MS = 150;
/** Marks code-view changes that came from the model, so they are not sent back. */
const fromModel = Annotation.define<boolean>();

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

const codeHighlight = HighlightStyle.define([
  { tag: [tags.tagName, tags.angleBracket], color: "var(--code-tag)" },
  { tag: tags.attributeName, color: "var(--code-attr)" },
  { tag: tags.attributeValue, color: "var(--code-val)" },
  { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.processingInstruction, tags.documentMeta], color: "var(--muted)" },
]);

function readTheme(): Theme {
  try {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export class Session {
  // ------------------------------------------------------------ reactive state
  editor: Editor = $state.raw(openOrEmpty(SAMPLE));
  /** Bumped on every document change: components read it to re-derive. */
  docVersion = $state(0);
  selection: NodeId[] = $state.raw([]);
  lock: LockInfo | null = $state.raw(null);
  mode: Mode = $state("editor");
  tool: Tool = $state("select");
  zoom = $state(1);
  grid = $state(false);
  snap = $state(false);
  /** Snap moved shapes to other shapes' edges and centres (guides). */
  snapShapes = $state(true);
  nodeEditing = $state(false);
  /** The selected point while editing a path's points. */
  activeNode: { seg: number; smooth: boolean; isStart: boolean } | null = $state(null);
  status: Status = $state({ text: "", error: false, id: 0 });
  docName = $state("Untitled.svg");
  dirty = $state(false);
  /** The app's own update (Windows and Linux). */
  update: UpdateState = $state({ state: "idle" });
  appVersion = $state("");
  updateAutoCheck = $state(true);
  updatesSupported = $state(false);
  /** The user asked (menu, palette, Settings): report "up to date" and errors too. */
  private manualUpdateCheck = false;
  overlay: Overlay = $state(null);
  theme: Theme = $state(readTheme());
  canUndo = $state(false);
  /** The code does not parse (the canvas keeps the last good drawing). */
  codeError: string | null = $state(null);
  canRedo = $state(false);

  // ------------------------------------------------------------ engine
  readonly view: EditorView;
  canvas: CanvasController | null = null;
  viewport: Viewport | null = null;
  private readonly editable = new Compartment();
  private savedText = SAMPLE;
  /** Line ending of the open file: CodeMirror and the model use "\n"; saves convert back. */
  private eol: "\n" | "\r\n" = "\n";
  private pending: ReturnType<typeof setTimeout> | undefined;
  private statusSeq = 0;

  constructor() {
    this.view = new EditorView({ state: EditorState.create({ doc: this.editor.text, extensions: this.extensions() }) });
    this.attach(this.editor);
    this.showSelectionStatus([]);
    this.applyTheme();
    window.desktop?.onMenu((action) => this.run(action));
    void window.desktop?.update?.get().then((u) => {
      this.appVersion = u.current;
      this.update = u.state;
      this.updateAutoCheck = u.autoCheck;
      this.updatesSupported = u.supported;
    });
    window.desktop?.update?.onState((u) => this.updateChanged(u));
  }

  private extensions(): Extension[] {
    return [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      xml(),
      syntaxHighlighting(codeHighlight),
      lintGutter(),
      selectionHighlight,
      this.editable.of([]),
      // No CodeMirror history: the model owns undo for code and canvas alike.
      keymap.of([
        { key: "Mod-z", run: () => this.undo(), preventDefault: true },
        { key: "Mod-Shift-z", run: () => this.redo(), preventDefault: true },
        { key: "Mod-y", run: () => this.redo(), preventDefault: true },
        ...defaultKeymap,
      ]),
      // Pointing at markup outlines its element on the canvas; Alt+drag on a number scrubs it.
      EditorView.domEventHandlers({
        mousemove: (e, view) => {
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
          const id = pos === null || view.state.doc.toString() !== this.editor.text ? undefined : this.editor.nodeAt(pos);
          this.canvas?.setHover(id === undefined || id === this.editor.doc.root ? null : id);
          const scrubbable = e.altKey && !this.lock && pos !== null && numberAt(view.state.doc.toString(), pos) !== null;
          view.contentDOM.style.cursor = scrubbable ? "ew-resize" : "";
        },
        mouseleave: (_e, view) => {
          this.canvas?.setHover(null);
          view.contentDOM.style.cursor = "";
        },
        mousedown: (e, view) => {
          if (!e.altKey || e.button !== 0 || this.lock) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
          const n = pos === null ? null : numberAt(view.state.doc.toString(), pos);
          if (!n) return false;
          e.preventDefault();
          this.scrub(view, n, e.clientX);
          return true;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.transactions.some((t) => t.annotation(fromModel))) return;
        if (u.docChanged) {
          if (this.pending !== undefined) clearTimeout(this.pending);
          this.pending = setTimeout(() => this.flush(), DEBOUNCE_MS);
          this.updateDirty();
          return;
        }
        // Code cursor -> selection (only when code and model agree).
        if (u.selectionSet && u.view.state.doc.toString() === this.editor.text) {
          const id = this.editor.nodeAt(u.state.selection.main.head);
          this.editor.select(id === undefined || id === this.editor.doc.root ? [] : [id]);
        }
      }),
    ];
  }

  /** Called by the stage once its elements exist. */
  attachStage(host: HTMLElement, overlay: SVGSVGElement, grid: SVGSVGElement): void {
    this.canvas = new CanvasController(host, overlay, this.editor, (tool) => (this.tool = tool));
    this.viewport = new Viewport(host, grid, () => {
      this.zoom = this.viewport!.zoom;
      this.grid = this.viewport!.grid;
      this.snap = this.viewport!.snapping;
      this.canvas?.refresh();
    });
    this.canvas.snapper = this.viewport;
    this.canvas.onActiveNode = (n) => (this.activeNode = n);
    this.canvas.onNodeError = (message) => this.showStatus(message, true);
    this.canvas.onNodeEdit = (on) => {
      this.nodeEditing = on;
      if (on) this.showStatus("Editing points: drag to move (Alt: a point alone), double-click the outline to add one, Delete to remove. Esc to finish.", false);
      else this.showSelectionStatus(this.editor.getSelection());
    };
    host.addEventListener("scroll", () => this.viewport?.drawGrid());
    this.editor.setBridges({ measure: (id) => this.canvas?.measure(id) ?? null });
    this.canvas.setTool("select");
    this.canvas.render();
    this.viewport.apply();
    requestAnimationFrame(() => this.viewport?.fit());
  }

  // ------------------------------------------------------------ code -> model

  /** Sends what is typed in the code view to the model (code -> model -> canvas). */
  flush = (): void => {
    if (this.pending !== undefined) clearTimeout(this.pending);
    this.pending = undefined;
    const text = this.view.state.doc.toString();
    if (text === this.editor.text) return;
    try {
      this.editor.setText(text);
      this.view.dispatch(setDiagnostics(this.view.state, []));
      this.codeError = null;
    } catch (e) {
      if (e instanceof SvgEditorError && e.code === "LOCKED") {
        // Typed just as a lock started: the document belongs to the lock holder now.
        this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: this.editor.text }, annotations: fromModel.of(true) });
        this.showStatus("Your last code edit was not applied: the document is locked.", true);
        return;
      }
      if (!(e instanceof SvgEditorError) || !e.parse) throw e;
      // Keep the last good model and render; mark the error in the code view.
      const from = Math.min(e.parse.offset, text.length);
      const to = Math.min(from + 1, text.length);
      this.view.dispatch(setDiagnostics(this.view.state, [{ from, to, severity: "error", message: `${e.message} ${e.hint}` }]));
      this.codeError = e.message;
      this.showStatus(e.message, true);
    }
  };

  /**
   * Drag-to-scrub a number in the code pane: 2 px per step of the number's own precision
   * (Shift: x10). The canvas follows live; the whole drag is one undo step; Esc cancels it.
   */
  private scrub(view: EditorView, n: ScrubNumber, startX: number): void {
    this.flush();
    if (view.state.doc.toString() !== this.editor.text) return this.showStatus("Fix the code error first, then scrub.", true);
    const batch = this.editor.beginBatch();
    let to = n.to;
    let changed = false;
    const move = (e: MouseEvent) => {
      const text = scrubbed(n, Math.round((e.clientX - startX) / 2), e.shiftKey);
      if (text === view.state.doc.sliceString(n.from, to)) return;
      view.dispatch({ changes: { from: n.from, to, insert: text } });
      to = n.from + text.length;
      changed = true;
      this.flush();
    };
    const end = (keep: boolean) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", key, true);
      document.body.style.cursor = "";
      if (keep) batch.commit();
      else {
        batch.rollback();
        // Put the code back to the model's text if the rollback did not already.
        if (view.state.doc.toString() !== this.editor.text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: this.editor.text }, annotations: fromModel.of(true) });
      }
      if (changed) this.showStatus(keep ? `Set to ${view.state.doc.sliceString(n.from, to)}` : "Scrub cancelled.", false);
    };
    const up = () => end(true);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      end(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", key, true);
    document.body.style.cursor = "ew-resize";
  }

  // ------------------------------------------------------------ model -> views

  private attach(ed: Editor): void {
    ed.onChange((c) => this.onDocumentChange(c));
    ed.onSelectionChange((ids) => this.onSelectionChange(ids));
    ed.onLockChange((info) => this.applyLock(info));
    if (this.canvas) ed.setBridges({ measure: (id) => this.canvas?.measure(id) ?? null });
  }

  private onDocumentChange(change: TextChangeEvent): void {
    if (change.origin !== "code") {
      this.view.dispatch({ changes: change.edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })), annotations: fromModel.of(true) });
      if (this.view.state.doc.toString() !== change.text) {
        this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: change.text }, annotations: fromModel.of(true) });
      }
      this.view.dispatch(setDiagnostics(this.view.state, []));
      this.codeError = null;
    }
    this.canvas?.render();
    this.viewport?.apply();
    this.canvas?.refresh();
    this.docVersion++;
    this.selection = this.editor.getSelection();
    this.canUndo = this.editor.canUndo();
    this.canRedo = this.editor.canRedo();
    this.highlight(this.selection);
    this.showSelectionStatus(this.selection);
    this.updateDirty();
  }

  private onSelectionChange(ids: NodeId[]): void {
    this.selection = ids;
    this.highlight(ids);
    this.showSelectionStatus(ids);
  }

  /** Lock on: the SDK refuses writes; views reflect it (read-only code, inert panels, Stop). */
  private applyLock(info: LockInfo | null): void {
    this.lock = info;
    if (info) this.canvas?.interrupt();
    this.view.dispatch({ effects: this.editable.reconfigure(info ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) });
  }

  showStatus(text: string, error: boolean): void {
    this.status = { text, error, id: ++this.statusSeq };
  }

  private showSelectionStatus(ids: NodeId[]): void {
    const doc = this.editor.doc;
    if (ids.length === 0) this.showStatus(`${doc.query().length - 1} elements`, false);
    else if (ids.length === 1) this.showStatus(`<${doc.getNode(ids[0]!).tag}> ${ids[0]} selected`, false);
    else this.showStatus(`${ids.length} elements selected`, false);
  }

  /** Selection -> code view: mark the nodes' source, scroll the first into view. */
  private highlight(ids: NodeId[]): void {
    const view = this.view;
    if (view.state.doc.toString() !== this.editor.text) return; // typing not flushed yet
    const ranges = ids.map((id) => this.editor.getSourceRange(id)).filter((r): r is { start: number; end: number } => r !== undefined);
    const effects = [setHighlights.of(ranges.map((r) => ({ from: r.start, to: r.end })))];
    const first = ranges[0];
    view.dispatch({
      effects: first && !view.hasFocus && view.dom.isConnected ? [...effects, EditorView.scrollIntoView(first.start, { y: "nearest" })] : effects,
      annotations: fromModel.of(true),
    });
  }

  private updateDirty(): void {
    const dirty = this.view.state.doc.toString() !== this.savedText;
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    window.desktop?.setDirty(dirty);
  }

  // ------------------------------------------------------------ history

  undo = (): boolean =>
    this.guard(() => {
      this.flush();
      this.canvas?.cancelGesture();
      this.editor.undo();
    });

  redo = (): boolean =>
    this.guard(() => {
      this.flush();
      this.canvas?.cancelGesture();
      this.editor.redo();
    });

  /** Runs a document action; while locked, explains instead of failing silently. */
  guard(fn: () => void): true {
    if (this.editor.lockInfo) {
      this.showStatus(`${this.editor.lockInfo.label} Stop it first.`, true);
      return true;
    }
    fn();
    return true;
  }

  stopLock(keep: boolean): void {
    const r = this.editor.stopLock({ keep });
    if (!r) return;
    if (!keep) this.showStatus("Stopped. The changes were discarded.", false);
    else this.showStatus(r.changed ? "Stopped. The changes so far were kept (one Ctrl+Z removes them)." : "Stopped. Nothing had changed.", false);
  }

  // ------------------------------------------------------------ files

  /** Loads a document: model, code view, canvas and panels start fresh (history too). */
  load(fileText: string, name = "Untitled.svg"): void {
    if (this.pending !== undefined) clearTimeout(this.pending);
    this.pending = undefined;
    this.eol = fileText.includes("\r\n") ? "\r\n" : "\n";
    const text = fileText.replace(/\r\n/g, "\n");
    this.canvas?.exitNodeEdit();
    this.editor = openOrEmpty(text);
    this.attach(this.editor);
    this.view.setState(EditorState.create({ doc: text, extensions: this.extensions() }));
    this.savedText = text;
    this.dirty = false;
    this.docName = name;
    this.codeError = null;
    this.canvas?.setEditor(this.editor);
    this.viewport?.apply();
    this.viewport?.fit();
    this.docVersion++;
    this.canUndo = false;
    this.canRedo = false;
    this.onSelectionChange([]);
    if (text !== this.editor.text) this.flush(); // did not parse: show the error in the code view
  }

  confirmDiscard(): boolean {
    return !this.dirty || window.confirm("Discard unsaved changes?");
  }

  async openFile(): Promise<void> {
    if (!this.confirmDiscard()) return;
    const file = await window.desktop.openFile();
    if (!file) return;
    this.overlay = null;
    this.load(file.text, file.name);
    if (this.text() === this.editor.text) this.showStatus(`Opened ${file.name}`, false);
  }

  async openRecent(id: number): Promise<void> {
    if (!this.confirmDiscard()) return;
    const file = await window.desktop.openRecent(id);
    if (!file) return this.showStatus("That file could not be opened; it may have been moved or deleted.", true);
    this.overlay = null;
    this.load(file.text, file.name);
    this.showStatus(`Opened ${file.name}`, false);
  }

  newDocument(): void {
    this.guard(() => {
      if (!this.confirmDiscard()) return;
      this.overlay = null;
      this.load(EMPTY_SVG);
      window.desktop?.newDocument();
    });
  }

  async save(as: boolean): Promise<boolean> {
    this.flush();
    const current = this.text();
    const out = this.eol === "\r\n" ? current.replace(/\n/g, "\r\n") : current;
    const r = as ? await window.desktop.saveAs(out) : await window.desktop.save(out);
    if (!r.saved) return false;
    this.savedText = current;
    this.dirty = false;
    if (r.name) this.docName = r.name;
    this.showStatus(`Saved ${r.name}`, false);
    return true;
  }

  async exportPng(): Promise<void> {
    this.flush();
    try {
      const r = await window.desktop.exportPng(await this.editor.exportPng());
      if (r.saved) this.showStatus(`Exported ${r.name}`, false);
    } catch (e) {
      this.showStatus(e instanceof Error ? e.message : String(e), true);
    }
  }

  toggleSnapShapes(): void {
    this.snapShapes = !this.snapShapes;
    if (this.canvas) this.canvas.snapShapes = this.snapShapes;
  }

  private updateChanged(u: UpdateState): void {
    this.update = u;
    const manual = this.manualUpdateCheck;
    if (u.state === "ready") this.showStatus(`Version ${u.version} is ready: restart to update.`, false);
    else if (u.state === "none" && manual) this.showStatus(`Curvant ${u.version} is the latest version.`, false);
    else if (u.state === "available") this.showStatus(`Version ${u.version} is available.`, false);
    else if ((u.state === "error" || u.state === "unsupported") && manual) this.showStatus(u.message, u.state === "error");
    if (u.state !== "checking") this.manualUpdateCheck = false;
  }

  checkForUpdates(): void {
    this.manualUpdateCheck = true;
    window.desktop.update.check();
  }

  async setUpdateAutoCheck(on: boolean): Promise<void> {
    this.updateAutoCheck = on;
    await window.desktop.update.setAutoCheck(on);
  }

  /** Restarts into the downloaded version: after the agent's turn, and with the drawing saved. */
  async restartToUpdate(): Promise<void> {
    if (this.update.state !== "ready") return;
    if (this.lock) return this.showStatus("The agent is working: stop it or let it finish, then restart to update.", true);
    if (this.dirty && !(await this.save(false))) return this.showStatus("Save the drawing first, then restart to update.", true);
    window.desktop.update.install();
  }

  /** A copy of the drawing as SVG text (the code pane keeps the original formatting). */
  svgText(style: SvgExportStyle): string {
    this.flush();
    return this.editor.toSvg({ pretty: style === "formatted" }) + (style === "formatted" ? "\n" : "");
  }

  async exportSvg(style: SvgExportStyle): Promise<void> {
    try {
      const r = await window.desktop.exportSvg(this.svgText(style), style);
      if (r.saved) this.showStatus(`Exported ${r.name}`, false);
      else if (r.error) this.showStatus(r.error, true);
    } catch (e) {
      this.showStatus(e instanceof Error ? e.message : String(e), true);
    }
  }

  text(): string {
    return this.view.state.doc.toString();
  }

  // ------------------------------------------------------------ path operations

  convertToPath(): void {
    this.guard(() => {
      this.flush();
      const ids = this.editor.getSelection();
      if (ids.length === 0) return this.showStatus("Select the shapes to convert first.", true);
      let paths: string[];
      try {
        paths = this.editor.batch(() => ids.map((id) => this.editor.doc.convertToPath(id))); // one undo step
      } catch (e) {
        return this.showStatus(e instanceof Error ? e.message : String(e), true);
      }
      this.editor.select(paths);
      if (paths.length === 1) this.canvas?.editNodes(paths[0]!);
      else this.showStatus(`Converted ${paths.length} shapes to paths.`, false);
    });
  }

  /** The selected siblings become one path (one undo step). */
  combine(operation: "union" | "subtract" | "intersect" | "exclude"): void {
    this.guard(() => {
      this.flush();
      const ids = this.editor.getSelection();
      if (ids.length < 2) return this.showStatus(`Select two or more shapes to ${operation}.`, true);
      try {
        const id = this.editor.doc.boolean(operation, ids);
        this.editor.select([id]);
        this.showStatus(`${operation[0]!.toUpperCase()}${operation.slice(1)} of ${ids.length} shapes. Ctrl+Z to undo.`, false);
      } catch (e) {
        this.showStatus(e instanceof Error ? e.message : String(e), true);
      }
    });
  }

  simplify(): void {
    this.guard(() => {
      this.flush();
      const paths = this.editor.getSelection().filter((id) => this.editor.doc.getNode(id).tag === "path");
      if (paths.length === 0) return this.showStatus("Select one or more paths to simplify (convert shapes first with Path > Convert to Path).", true);
      try {
        const results = this.editor.batch(() => paths.map((id) => this.editor.doc.simplify(id))); // one undo step
        const before = results.reduce((n, r) => n + r.nodes.before, 0);
        const after = results.reduce((n, r) => n + r.nodes.after, 0);
        this.showStatus(`Simplified: ${before} → ${after} points. Ctrl+Z to undo.`, false);
      } catch (e) {
        this.showStatus(e instanceof Error ? e.message : String(e), true);
      }
    });
  }

  editNodes(): void {
    this.guard(() => {
      const ids = this.editor.getSelection();
      if (ids.length !== 1 || !this.canvas?.editNodes(ids[0]!)) this.showStatus("Select one path to edit its nodes (convert shapes first with Path > Convert to Path).", true);
    });
  }

  /** Aligns the selection in drawing coordinates (one undo step). */
  align(edge: "left" | "center" | "right" | "top" | "middle" | "bottom"): void {
    this.guard(() => {
      const ids = this.editor.getSelection();
      if (ids.length < 2) return this.showStatus("Select two or more shapes to align them.", true);
      try {
        const doc = this.editor.doc;
        const boxes = ids.map((id) => ({ id, b: doc.getBBox(id, "root") }));
        const minX = Math.min(...boxes.map((x) => x.b.x));
        const maxX = Math.max(...boxes.map((x) => x.b.x + x.b.width));
        const minY = Math.min(...boxes.map((x) => x.b.y));
        const maxY = Math.max(...boxes.map((x) => x.b.y + x.b.height));
        this.editor.batch(() => {
          for (const { id, b } of boxes) {
            const dx = edge === "left" ? minX - b.x : edge === "right" ? maxX - (b.x + b.width) : edge === "center" ? (minX + maxX) / 2 - (b.x + b.width / 2) : 0;
            const dy = edge === "top" ? minY - b.y : edge === "bottom" ? maxY - (b.y + b.height) : edge === "middle" ? (minY + maxY) / 2 - (b.y + b.height / 2) : 0;
            if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) doc.translateInRoot(id, [dx, dy]);
          }
        });
      } catch (e) {
        this.showStatus(e instanceof Error ? e.message : String(e), true);
      }
    });
  }

  // ------------------------------------------------------------ view

  setMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.flush();
    const swap = () => {
      this.mode = mode;
      if (mode === "agent") this.canvas?.exitNodeEdit();
      // The canvas area changed size: keep the drawing framed.
      requestAnimationFrame(() => {
        this.viewport?.apply();
        this.canvas?.refresh();
      });
    };
    // Crossfade the two layouts where the platform supports it.
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && !reducedMotion()) doc.startViewTransition(swap);
    else swap();
  }

  toggleMode(): void {
    this.setMode(this.mode === "editor" ? "agent" : "editor");
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", theme);
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
    this.applyTheme();
  }

  private applyTheme(): void {
    const root = document.documentElement;
    if (this.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = this.theme;
    const dark = this.theme === "dark" || (this.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    window.desktop?.setTitleBarTheme?.(dark ? "dark" : "light");
  }

  // ------------------------------------------------------------ actions

  /** Every menu action, from the native menu, the title bar menus and the command palette. */
  readonly actions: Record<MenuAction, () => void> = {
    new: () => this.newDocument(),
    open: () => this.guard(() => void this.openFile()),
    save: () => this.guard(() => void this.save(false)),
    saveAs: () => this.guard(() => void this.save(true)),
    saveAndClose: () => this.guard(() => void this.save(false).then((ok) => ok && window.desktop.closeWindow())),
    export: () => this.guard(() => (this.overlay = "export")),
    exportPng: () => this.guard(() => void this.exportPng()),
    simulateAiTurn: () => void this.simulateAiTurn(),
    convertToPath: () => this.convertToPath(),
    editNodes: () => this.editNodes(),
    union: () => this.combine("union"),
    subtract: () => this.combine("subtract"),
    intersect: () => this.combine("intersect"),
    exclude: () => this.combine("exclude"),
    simplify: () => this.simplify(),
    zoomIn: () => this.viewport?.zoomIn(),
    zoomOut: () => this.viewport?.zoomOut(),
    zoom100: () => this.viewport?.setZoom(1),
    zoomFit: () => this.viewport?.fit(),
    toggleGrid: () => this.viewport?.toggleGrid(),
    toggleSnap: () => this.viewport?.toggleSnap(),
    toggleSnapShapes: () => this.toggleSnapShapes(),
    checkUpdates: () => this.checkForUpdates(),
    undo: () => void this.undo(),
    redo: () => void this.redo(),
    toggleMode: () => this.toggleMode(),
    commandPalette: () => (this.overlay = this.overlay === "palette" ? null : "palette"),
    settings: () => (this.overlay = "settings"),
    startScreen: () => (this.overlay = "start"),
  };

  run(action: MenuAction): void {
    this.actions[action]?.();
  }

  // ------------------------------------------------------------ lock demo

  /** Debug menu: a fake AI turn (timed edits under a lock) to try the lock, Stop and single-step undo. */
  async simulateAiTurn(): Promise<void> {
    if (this.editor.lockInfo) return;
    this.flush();
    const ed = this.editor;
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
      this.showStatus("Simulated AI turn finished. One Ctrl+Z removes all of it.", false);
    } catch (e) {
      if (e instanceof SvgEditorError && e.code === "LOCK_STOPPED") return; // Stop already reported
      this.showStatus(e instanceof Error ? e.message : String(e), true);
    }
  }
}

function openOrEmpty(text: string): Editor {
  try {
    return createEditor({ svg: text, rasterize });
  } catch (e) {
    if (!(e instanceof SvgEditorError)) throw e;
    return createEditor({ svg: EMPTY_SVG, rasterize });
  }
}

function sleep(ms: number, signal: AbortSignalLike): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

export const session = new Session();
