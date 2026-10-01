import {
  ANIMATION_TAGS,
  applyToPoint,
  formatNumber,
  IDENTITY,
  invert,
  multiply,
  readAnimation,
  timelineEnd,
  CommandFailure,
  parsePath,
  parseTransform,
  serialize,
  TEXT_TAG,
  transformBBox,
  type BBox,
  type Command,
  type CommandError,
  type CommandResultMap,
  type AnimationInfo,
  type Matrix,
  type MotionOptions,
  type Mutation,
  type MotionPreset,
  type NodeData,
  type NodeId,
  type PathMove,
  type PathNodeOp,
  type PathSegment,
  type Query,
  type SerializeOptions,
  type SvgNode,
  type TreeNode,
  type Vec2,
} from "@svg-editor/model";
import { openSvg, type SourceDocument, type TextEdit } from "@svg-editor/parser";
import { SvgEditorError, type SdkErrorCode } from "./errors.js";
import { newAbortController, startTimer, stopTimer, type AbortSignalLike } from "./platform.js";

/** Attribute values: numbers are written with at most 6 decimals. `null` removes (in `set`). */
export type AttrValue = string | number;

export interface TransformOptions {
  translate?: Vec2;
  scale?: Vec2 | number;
  /** Degrees, clockwise. */
  rotate?: number;
  /** Default [0, 0]. "center" uses the element's bounding box. */
  origin?: "center" | Vec2;
  /** "parent" (default) or "local" (along the element's own axes). */
  space?: "parent" | "local";
}

export interface AnimateOptions extends MotionOptions {
  /** Seconds added to each next element's delay, in the order given (default 0). */
  stagger?: number;
}

/** One animation element and what it does. */
export interface AnimationEntry extends AnimationInfo {
  /** The <animate>/<animateTransform>/… element. */
  id: NodeId;
  tag: string;
  /** The element it animates. */
  target: NodeId;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Something that can draw SVG text to PNG bytes (the desktop app passes a DOM one). */
export type Rasterizer = (svg: string, size: { width: number; height: number }) => Promise<Uint8Array>;

/** Measures elements the headless geometry cannot (paths, text); returns root-space boxes. */
export type Measurer = (id: NodeId) => BBox | null;

export interface Bridges {
  rasterize?: Rasterizer | undefined;
  measure?: Measurer | undefined;
}

export interface CreateEditorOptions extends Bridges {
  /** Initial SVG text. Defaults to an empty 400x300 drawing. */
  svg?: string;
}

/** A text change, with minimal edits (e.g. for a code editor) and where it came from. */
export interface TextChangeEvent {
  text: string;
  edits: TextEdit[];
  /** "code": `setText`; "model": commands, undo, redo. */
  origin: "code" | "model";
}

/** Result of the non-throwing `execute()`: like the model's, but with SDK error codes (e.g. LOCKED). */
export type ExecuteResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: { code: SdkErrorCode; message: string; hint: string; path?: number[] | undefined } };

export interface ExportPngOptions {
  scale?: number;
  /** Root user units (viewBox coordinates). */
  region?: BBox;
  /** Longest side in pixels (shrinks only). */
  maxSize?: number;
  /** Scales up or down so the longer side is exactly this many pixels (overrides scale and maxSize). */
  longSide?: number;
  /** CSS colour under the drawing; default transparent. */
  background?: string;
}

export interface LockOptions {
  /** Who holds the lock, e.g. "ai". Shown in errors. */
  reason: string;
  /** Text for a banner, e.g. "AI is editing…". */
  label?: string;
  /** Stops (and rolls back) automatically after this long. */
  timeoutMs?: number;
}

export interface LockInfo {
  reason: string;
  label: string;
  startedAt: number;
}

/** How a lock session ended. `changed` is false when nothing was modified. */
export interface LockOutcome {
  kept: boolean;
  changed: boolean;
  stopped: boolean;
}

export const EMPTY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">\n</svg>\n`;

/**
 * Creates an editor from SVG text. Throws SvgEditorError (PARSE_ERROR, with
 * line and column) if the text is not well-formed SVG.
 */
export function createEditor(options: CreateEditorOptions = {}): Editor {
  const r = openSvg(options.svg ?? EMPTY_SVG);
  if (!r.ok) throw SvgEditorError.fromParse(r.error);
  return new Editor(r.source, options);
}

/**
 * One open document: commands and queries (`editor.doc`), undo/redo and
 * batching, selection, and the formatting-preserving source text.
 *
 * Everything the desktop app does to a document goes through this class, so
 * scripts and the AI can do the same things.
 */
export class Editor {
  readonly doc: DocumentApi;
  private selection: NodeId[] = [];
  private readonly selectionListeners = new Set<(ids: NodeId[]) => void>();
  private bridges: Bridges;
  private lockState: {
    token: object;
    info: LockInfo;
    tx: { commit(): void; rollback(): void };
    controller: ReturnType<typeof newAbortController>;
    timer?: unknown;
    versionAtStart: number;
    stopped: boolean;
  } | null = null;
  private readonly lockListeners = new Set<(info: LockInfo | null) => void>();

  /** @internal Use createEditor(). */
  constructor(
    private readonly source: SourceDocument,
    bridges: Bridges = {},
  ) {
    this.bridges = { rasterize: bridges.rasterize, measure: bridges.measure };
    this.doc = new DocumentApi(this, null);
    // Keep the selection valid when nodes go away (delete, undo, code edits).
    source.onChange(() => {
      const kept = this.selection.filter((id) => this.source.doc.getNode(id));
      if (kept.length !== this.selection.length) this.setSelection(kept);
    });
  }

  /** @internal */
  get model() {
    return this.source.doc;
  }

  /** Plugs in renderer capabilities later (e.g. once the canvas exists). */
  setBridges(bridges: Bridges): void {
    this.bridges = { ...this.bridges, ...bridges };
  }

  // ---------------------------------------------------------------- text

  /** The document as text, with the original formatting, comments and attribute order kept. */
  get text(): string {
    return this.source.text;
  }

  /**
   * Replaces the text (a code edit). Node IDs are kept where the element is
   * recognizably the same. One undo step. Throws PARSE_ERROR and changes
   * nothing if the text does not parse.
   */
  setText(text: string): { kept: number; created: number; removed: number } {
    this.gate(null);
    const r = this.source.setText(text);
    if (!r.ok) throw SvgEditorError.fromParse(r.error);
    return { kept: r.kept, created: r.created, removed: r.removed };
  }

  /** A freshly serialized copy (does not keep formatting; use `text` for that). */
  toSvg(options: SerializeOptions = {}): string {
    return this.model.toSvg(options);
  }

  /** Called after every change with minimal text edits. Returns an unsubscribe function. */
  onChange(listener: (e: TextChangeEvent) => void): () => void {
    return this.source.onChange((c) => listener({ text: c.text, edits: c.edits, origin: c.method === "code" ? "code" : "model" }));
  }

  /**
   * Low-level changes as they are applied (commands, undo, redo, rollbacks and code edits
   * alike): "insert", "remove", "move", "attrs" (an element's full new attribute set) or
   * "text". For views that update incrementally; most callers want onChange.
   */
  onMutation(listener: (m: Mutation) => void): () => void {
    return this.model.onMutation(listener);
  }

  /** Source offsets of a node's text (for highlighting it in a code view). */
  getSourceRange(id: NodeId): { start: number; end: number } | undefined {
    return this.source.getSource(id);
  }

  /** The deepest element at a source offset (for "cursor in code selects node"). */
  nodeAt(offset: number): NodeId | undefined {
    return this.source.nodeAt(offset);
  }

  // -------------------------------------------------------------- history

  /** Throws LOCKED while the document is locked. */
  undo(): boolean {
    this.gate(null);
    return this.model.undo();
  }

  redo(): boolean {
    this.gate(null);
    return this.model.redo();
  }

  canUndo(): boolean {
    return this.model.canUndo();
  }

  canRedo(): boolean {
    return this.model.canRedo();
  }

  /** Changes that could not be written as a minimal text patch (formatting was regenerated). Should stay 0. */
  get patchFallbacks(): number {
    return this.source.fallbacks;
  }

  /** Increments on every change. */
  get version(): number {
    return this.model.version;
  }

  /**
   * Runs `fn` as one undo step. If it throws, everything it did is rolled
   * back and the error is rethrown.
   */
  batch<T>(fn: () => T): T {
    return this.transactionAs(null, fn);
  }

  /** Starts a batch that can span `await`s (e.g. a whole AI turn). Call commit() or rollback(). */
  beginBatch(): { commit(): void; rollback(): void } {
    this.gate(null);
    return this.model.beginTransaction();
  }

  /**
   * Runs a serializable command without throwing: `{ ok, result }` or
   * `{ ok: false, error: { code, message, hint } }`. This is the form the
   * AI tool dispatcher uses.
   */
  execute<C extends Command>(cmd: C): ExecuteResult<CommandResultMap[C["op"]]>;
  execute(cmd: unknown): ExecuteResult;
  execute(cmd: unknown): ExecuteResult {
    return this.executeAs(null, cmd);
  }

  // ----------------------------------------------------------------- lock

  /**
   * Locks the document for one holder (e.g. an AI turn). Until the session
   * ends, every write that does not go through the session throws LOCKED
   * (reads and selection still work). The whole session is one undo step.
   * End it with commit(), rollback() or stop(); prefer runLocked(), which
   * always ends it.
   */
  lock(options: LockOptions): LockSession {
    if (this.lockState) this.gate(null);
    if (this.model.inTransaction) {
      throw new SvgEditorError("LOCKED", "Cannot lock while a batch is in progress.", "Finish the current batch first.");
    }
    const token = {};
    const info: LockInfo = { reason: options.reason, label: options.label ?? `${options.reason} is editing…`, startedAt: Date.now() };
    const controller = newAbortController();
    const tx = this.model.beginTransaction();
    this.lockState = { token, info, tx, controller, versionAtStart: this.model.version, stopped: false };
    const session = new LockSession(this, token, info, controller.signal);
    if (options.timeoutMs !== undefined) {
      this.lockState.timer = startTimer(() => session.stop({ keep: false }), options.timeoutMs);
    }
    this.emitLock();
    return session;
  }

  /**
   * Runs `fn` under a lock: commits if it finishes, rolls back if it throws,
   * and unlocks in every case. If the session is stopped meanwhile (UI Stop
   * button, timeout), `fn`'s later writes fail and this rejects with LOCK_STOPPED.
   */
  async runLocked<T>(options: LockOptions, fn: (session: LockSession) => Promise<T> | T): Promise<T> {
    const session = this.lock(options);
    try {
      const value = await fn(session);
      if (session.active) session.commit();
      else if (session.stopped) throw stoppedError();
      return value;
    } catch (e) {
      if (session.active) session.rollback();
      if (session.stopped && !(e instanceof SvgEditorError && e.code === "LOCK_STOPPED")) throw stoppedError();
      throw e;
    } finally {
      if (session.active) session.rollback();
    }
  }

  /** The current lock, or null. */
  get lockInfo(): LockInfo | null {
    return this.lockState ? { ...this.lockState.info } : null;
  }

  /** Called when the document is locked (info) or unlocked (null). */
  onLockChange(listener: (info: LockInfo | null) => void): () => void {
    this.lockListeners.add(listener);
    return () => this.lockListeners.delete(listener);
  }

  /** Stops the current lock session, whoever holds it (the UI's Stop button). */
  stopLock(options: { keep?: boolean } = {}): LockOutcome | null {
    const l = this.lockState;
    return l ? this.release(l.token, options.keep ?? false, true) : null;
  }

  /** @internal Throws unless `token` may write now. */
  gate(token: object | null): void {
    const l = this.lockState;
    if (token !== null && (!l || l.token !== token)) {
      throw new SvgEditorError("LOCK_RELEASED", "This lock session has already ended; its changes were committed or rolled back.", "Start a new session with editor.lock().");
    }
    if (l && token !== l.token) {
      throw new SvgEditorError("LOCKED", `The document is locked: ${l.info.label}`, "Wait until it finishes, or stop it (Stop button / editor.stopLock()).");
    }
  }

  /** @internal */
  executeAs(token: object | null, cmd: unknown): ExecuteResult {
    try {
      this.gate(token);
    } catch (e) {
      const err = e as SvgEditorError;
      return { ok: false, error: { code: err.code, message: err.message, hint: err.hint } };
    }
    return this.model.execute(cmd);
  }

  /** @internal */
  transactionAs<T>(token: object | null, fn: () => T): T {
    this.gate(token);
    return this.model.transaction(fn);
  }

  /** @internal Ends a session; idempotent. Always unlocks. */
  release(token: object, keep: boolean, stopped: boolean): LockOutcome | null {
    const l = this.lockState;
    if (!l || l.token !== token) return null;
    if (l.timer !== undefined) stopTimer(l.timer);
    if (stopped) {
      l.stopped = true;
      l.controller.abort(new SvgEditorError("LOCK_STOPPED", "The lock session was stopped.", "Stop requested by the user or a timeout."));
    }
    const changed = this.model.version !== l.versionAtStart;
    try {
      if (keep) l.tx.commit();
      else l.tx.rollback();
    } finally {
      this.lockState = null;
      this.emitLock();
    }
    return { kept: keep && changed, changed, stopped };
  }

  private emitLock(): void {
    const info = this.lockInfo;
    for (const l of this.lockListeners) l(info);
  }

  // ------------------------------------------------------------ selection

  getSelection(): NodeId[] {
    return [...this.selection];
  }

  /** Selects exactly these nodes. Unknown IDs throw NOT_FOUND; duplicates and the root are ignored. */
  select(ids: NodeId | NodeId[]): void {
    const list = typeof ids === "string" ? [ids] : ids;
    for (const id of list) this.doc.getNode(id);
    this.setSelection(list.filter((id, i) => list.indexOf(id) === i && id !== this.model.root));
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  /**
   * Selects the top-level elements (children of the root or of Inkscape
   * layers) whose bounding box lies inside `rect` (root user units): what a
   * marquee drag does on the canvas. Elements that cannot be measured are skipped.
   */
  selectInRect(rect: Rect): NodeId[] {
    const inside = this.doc.topLevel().filter((id) => {
      const b = this.doc.tryBBox(id, "root");
      return b !== null && b.x >= rect.x && b.y >= rect.y && b.x + b.width <= rect.x + rect.width && b.y + b.height <= rect.y + rect.height;
    });
    this.setSelection(inside);
    return inside;
  }

  onSelectionChange(listener: (ids: NodeId[]) => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  private setSelection(ids: NodeId[]): void {
    const same = ids.length === this.selection.length && ids.every((id, i) => id === this.selection[i]);
    if (same) return;
    this.selection = ids;
    for (const l of this.selectionListeners) l(this.getSelection());
  }

  // --------------------------------------------------------------- export

  /** The drawing's size at 100%: width/height when absolute, else the viewBox, else 300x150. */
  intrinsicSize(): { width: number; height: number } {
    const a = this.model.getNode(this.model.root)!.attrs;
    const vb = (a.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
    const [vbw, vbh] = vb.length === 4 && vb.every(Number.isFinite) ? [vb[2]!, vb[3]!] : [0, 0];
    const len = (v: string | undefined): number | null => {
      if (v === undefined) return null;
      const m = /^\s*([\d.]+)\s*(px|pt|mm|cm|in)?\s*$/.exec(v);
      if (!m) return null;
      const unit = { px: 1, pt: 4 / 3, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }[m[2] ?? "px"]!;
      return Number(m[1]) * unit;
    };
    let width = len(a.width);
    let height = len(a.height);
    if (width === null && height !== null && vbw && vbh) width = (height * vbw) / vbh;
    if (height === null && width !== null && vbw && vbh) height = (width * vbh) / vbw;
    return { width: width ?? (vbw || 300), height: height ?? (vbh || 150) };
  }

  /**
   * PNG bytes. Needs a rasterizer bridge (the desktop app has one; headless scripts can plug one in).
   *
   * - `scale`: pixels per CSS pixel of the drawing's own size (default 1).
   * - `region`: only this rectangle, in root user units (viewBox coordinates). It may reach
   *   outside the page; content there is drawn too.
   * - `maxSize`: caps the longer side in pixels, shrinking the image to fit.
   * - `longSide`: scales the image so its longer side is exactly this many pixels.
   * - `background`: a CSS colour painted under the drawing (default: transparent).
   */
  async exportPng(options: ExportPngOptions = {}): Promise<Uint8Array> {
    const rasterize = this.bridges.rasterize;
    if (!rasterize) {
      throw new SvgEditorError("NO_RASTERIZER", "No rasterizer is available to draw PNGs.", "Pass `rasterize` to createEditor() or setBridges(); in the desktop app it is set up for you.");
    }
    const { svg, width, height } = this.exportSvg(options);
    try {
      return await rasterize(svg, { width, height });
    } catch (e) {
      throw new SvgEditorError("EXPORT_FAILED", `PNG export failed: ${(e as Error).message}`, "Check that the drawing renders; external images are not loaded.");
    }
  }

  /** @internal The SVG text and pixel size exportPng() rasterizes. */
  exportSvg(options: ExportPngOptions = {}): { svg: string; width: number; height: number } {
    const scale = options.scale ?? 1;
    if (!(scale > 0) || !Number.isFinite(scale)) throw new SvgEditorError("INVALID_REGION", `scale must be a positive number, got ${scale}.`, "Use e.g. { scale: 2 }.");
    const size = this.intrinsicSize();
    const rootNode = this.model.getNode(this.model.root)!;
    const vb = (rootNode.attrs.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
    const page = vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0
      ? { x: vb[0]!, y: vb[1]!, width: vb[2]!, height: vb[3]! }
      : { x: 0, y: 0, width: size.width, height: size.height };
    const r = options.region;
    if (r && !(Number.isFinite(r.x) && Number.isFinite(r.y) && r.width > 0 && r.height > 0 && Number.isFinite(r.width) && Number.isFinite(r.height))) {
      throw new SvgEditorError("INVALID_REGION", `The region ${JSON.stringify(r)} is not a rectangle with positive width and height.`, `Use root user units, e.g. the page is ${JSON.stringify(page)}.`);
    }
    const area = r ?? page;
    // Whole drawing: its own size (and its own viewBox/aspect handling). Region: the same
    // pixels per user unit as the drawing at its own size.
    let width = r ? r.width * (size.width / page.width) * scale : size.width * scale;
    let height = r ? r.height * (size.height / page.height) * scale : size.height * scale;
    const max = options.maxSize;
    if (options.longSide !== undefined && options.longSide > 0) {
      const k = options.longSide / Math.max(width, height);
      width *= k;
      height *= k;
    } else if (max !== undefined && max > 0 && Math.max(width, height) > max) {
      const k = max / Math.max(width, height);
      width *= k;
      height *= k;
    }
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));

    const f = formatNumber;
    const bgId = "__export_background";
    const get = (id: NodeId): SvgNode => {
      if (id === bgId) {
        return { id, tag: "rect", attrs: { x: f(area.x), y: f(area.y), width: f(area.width), height: f(area.height), fill: options.background! }, children: [], parent: this.model.root };
      }
      const n = this.model.getNode(id)!;
      if (id !== this.model.root) return n;
      const attrs: Record<string, string> = { xmlns: "http://www.w3.org/2000/svg", ...n.attrs };
      if (r) {
        attrs.viewBox = `${f(area.x)} ${f(area.y)} ${f(area.width)} ${f(area.height)}`;
        attrs.preserveAspectRatio = "none";
        attrs.width = String(width);
        attrs.height = String(height);
      }
      return { ...n, attrs, children: options.background ? [bgId, ...n.children] : n.children };
    };
    // SMIL in an image starts at t=0: export the drawing at rest instead.
    return { svg: serialize(get, this.model.root, { static: true }), width, height };
  }

  /** @internal */
  measure(id: NodeId): BBox | null {
    return this.bridges.measure?.(id) ?? null;
  }
}

/** Document commands and queries. Write methods throw SvgEditorError; they never half-apply. */
export class DocumentApi {
  constructor(
    private readonly editor: Editor,
    /** null: the editor's own API; otherwise a lock session's token. */
    private readonly token: object | null,
  ) {}

  private get m() {
    return this.editor.model;
  }

  private run<C extends Command>(cmd: C): CommandResultMap[C["op"]] {
    const r = this.editor.executeAs(this.token, cmd);
    if (!r.ok) throw r.error.code === "LOCKED" || r.error.code === "LOCK_RELEASED" ? new SvgEditorError(r.error.code, r.error.message, r.error.hint) : SvgEditorError.fromCommand(r.error as CommandError);
    return r.result as CommandResultMap[C["op"]];
  }

  get root(): NodeId {
    return this.m.root;
  }

  // ---------------------------------------------------------------- write

  /** Adds an element; returns its ID. Appends to the root unless `parent` / `index` say otherwise. */
  add(tag: string, attrs: Record<string, AttrValue> = {}, at: { parent?: NodeId; index?: number } = {}): NodeId {
    return this.run({ op: "add", tag, attrs: toStrings(attrs), ...at }).id;
  }

  /** Sets attributes; `null` removes one. */
  set(id: NodeId, attrs: Record<string, AttrValue | null>): void {
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(attrs)) out[k] = v === null ? null : toString(v);
    this.run({ op: "set", id, attrs: out });
  }

  /** Deletes nodes (and their children). */
  delete(ids: NodeId | NodeId[]): void {
    this.run({ op: "delete", ids: typeof ids === "string" ? [ids] : ids });
  }

  /** Moves a node under `parent` to final position `index` (reorder or reparent). */
  move(id: NodeId, parent: NodeId, index: number): void {
    this.run({ op: "move", id, parent, index });
  }

  /** Wraps sibling nodes in a new <g>; returns its ID. */
  group(ids: NodeId[]): NodeId {
    return this.run({ op: "group", ids }).id;
  }

  /**
   * A <path>'s data as absolute segments (M, L, C, Q, A, Z): the indices and
   * points pathEdit() works with, in the path's own coordinates.
   */
  getPath(id: NodeId): PathSegment[] {
    const n = this.getNode(id);
    if (n.tag !== "path") throw new SvgEditorError("NOT_A_PATH", `"${id}" is a <${n.tag}>, not a <path>.`, "Convert it first with convertToPath(id).");
    try {
      return parsePath(n.attrs.d ?? "");
    } catch (e) {
      if (e instanceof CommandFailure) throw SvgEditorError.fromCommand(e.error);
      throw e;
    }
  }

  /**
   * Moves path points: end points ("p") and control points ("c1"/"c2" of C, "c" of Q),
   * by segment index from getPath(). End points take their handles along unless
   * `handles: false`. One undo step; returns the new `d` (absolute form).
   */
  pathEdit(id: NodeId, moves: PathMove[], options: { handles?: boolean } = {}): string {
    return this.run({ op: "pathEdit", id, moves, ...(options.handles !== undefined ? { handles: options.handles } : {}) }).d;
  }

  /**
   * Node-level path edits, by segment index from getPath() (a node is its segment's end point):
   * insert a node on a segment at t (0..1) without changing the outline, delete a node, make a
   * node a corner (handles pulled in) or smooth (handles in line), or make a segment a line or a
   * curve. One undo step; returns the new `d`. Indices after the edited node shift.
   */
  pathNode(id: NodeId, op: PathNodeOp): string {
    return this.run({ op: "pathNode", id, ...op }).d;
  }

  /** Replaces a rect, circle, ellipse, line, polyline or polygon by an equivalent <path>; returns the new path's ID. */
  convertToPath(id: NodeId): NodeId {
    return this.run({ op: "convertToPath", id }).id;
  }

  /**
   * Combines sibling shapes (paths or basic shapes) into one <path>, bottom to top:
   * union, subtract (the bottom one minus the others), intersect or exclude. The result
   * takes the bottom shape's attributes and place; returns its ID. One undo step.
   */
  boolean(operation: "union" | "subtract" | "intersect" | "exclude", ids: NodeId[]): NodeId {
    return this.run({ op: "boolean", operation, ids }).id;
  }

  /** Refits a <path> with fewer points; `tolerance` is the largest deviation in its units (default 1). */
  simplify(id: NodeId, options: { tolerance?: number } = {}): { d: string; nodes: { before: number; after: number } } {
    const r = this.run({ op: "simplify", id, ...(options.tolerance !== undefined ? { tolerance: options.tolerance } : {}) });
    return { d: r.d, nodes: r.nodes };
  }

  /** Removes a <g>, keeping its children in place; returns their IDs. */
  ungroup(id: NodeId): NodeId[] {
    return this.run({ op: "ungroup", id }).ids;
  }

  /** Translates / scales / rotates by adding to the element's `transform`. Returns the new value. */
  transform(id: NodeId, t: TransformOptions): string {
    const scale = typeof t.scale === "number" ? ([t.scale, t.scale] as Vec2) : t.scale;
    return this.run({
      op: "transform",
      id,
      ...(t.translate ? { translate: t.translate } : {}),
      ...(scale ? { scale } : {}),
      ...(t.rotate !== undefined ? { rotate: t.rotate } : {}),
      ...(t.origin !== undefined ? { origin: t.origin } : {}),
      ...(t.space ? { space: t.space } : {}),
    }).transform;
  }

  /** Sets the text of an element (or text node). "" removes it. */
  setText(id: NodeId, text: string): void {
    this.run({ op: "setText", id, text });
  }

  /** Adds a <text> element with content in one undo step; returns its ID. */
  addText(text: string, attrs: Record<string, AttrValue> = {}, at: { parent?: NodeId; index?: number } = {}): NodeId {
    return this.editor.transactionAs(this.token, () => {
      const id = this.add("text", attrs, at);
      this.setText(id, text);
      return id;
    });
  }

  /**
   * Adds a motion preset to each element (SMIL children tagged data-motion), replacing
   * that preset where it is already applied. One undo step. `stagger` adds that many
   * seconds to each next element's delay. Returns the IDs of the animation elements.
   */
  animate(ids: NodeId | NodeId[], preset: MotionPreset, options: AnimateOptions = {}): NodeId[] {
    const list = typeof ids === "string" ? [ids] : ids;
    const { stagger = 0, ...motion } = options;
    if (!(typeof stagger === "number" && Number.isFinite(stagger) && stagger >= 0)) {
      throw new SvgEditorError("INVALID_COMMAND", `stagger must be seconds (0 or more), got ${JSON.stringify(stagger)}.`, "Example: { stagger: 0.1 }.");
    }
    return this.editor.transactionAs(this.token, () =>
      list.flatMap((id, i) => {
        const delay = (motion.delay ?? 0) + i * stagger;
        const box = this.has(id) && this.m.getBBox(id).ok ? undefined : this.localBoxFromRoot(id);
        return this.run({
          op: "animate",
          id,
          preset,
          ...motion,
          ...(delay > 0 || motion.delay !== undefined ? { delay: Math.round(delay * 1000) / 1000 } : {}),
          ...(box ? { box } : {}),
        }).ids;
      }),
    );
  }

  /** Removes animations from each element: those of `preset`, or all of them. Returns how many went. */
  removeAnimations(ids: NodeId | NodeId[], preset?: string): number {
    const list = typeof ids === "string" ? [ids] : ids;
    return this.editor.transactionAs(this.token, () =>
      list.reduce((n, id) => n + this.run({ op: "removeAnimations", id, ...(preset !== undefined ? { preset } : {}) }).removed, 0),
    );
  }

  /** The animations on one element, or in the whole document. */
  getAnimations(id?: NodeId): AnimationEntry[] {
    const out: AnimationEntry[] = [];
    const ids = id === undefined ? [...ANIMATION_TAGS].flatMap((tag) => this.m.query({ tag })) : this.getNode(id).children;
    for (const a of ids) {
      const n = this.getNode(a);
      if (!ANIMATION_TAGS.has(n.tag) || n.parent === null) continue;
      out.push({ id: a, tag: n.tag, target: n.parent, ...readAnimation(n.tag, n.attrs) });
    }
    // Document order, whatever the tag.
    if (id === undefined && out.length > 1) {
      const order = new Map(this.m.query({}).map((x, i) => [x, i]));
      out.sort((x, y) => order.get(x.id)! - order.get(y.id)!);
    }
    return out;
  }

  /** Seconds until everything that starts on load has played once (loops count once); 0 without animations. */
  timelineDuration(): number {
    return timelineEnd(this.getAnimations());
  }

  /** An element's box in its own coordinates from the measure bridge (exact centre; size approximate when rotated). */
  private localBoxFromRoot(id: NodeId): BBox | null {
    const root = this.has(id) ? this.editor.measure(id) : null;
    if (!root) return null;
    const inv = invert(this.toRootMatrix(id));
    if (!inv) return null;
    return transformBBox(inv, root);
  }

  // ----------------------------------------------------------------- read

  /** Plain-data tree (no DOM). Throws NOT_FOUND for an unknown ID. */
  getTree(id: NodeId = this.root): TreeNode {
    const t = this.m.getTree(id);
    if (!t) throw notFound(id);
    return t;
  }

  /** Plain-data node. Throws NOT_FOUND for an unknown ID. */
  getNode(id: NodeId): NodeData {
    const n = this.m.getNode(id);
    if (!n) throw notFound(id);
    return n;
  }

  has(id: NodeId): boolean {
    return this.m.getNode(id) !== undefined;
  }

  /** IDs matching tag / attributes, in document order. */
  query(q: Query = {}): NodeId[] {
    return this.m.query(q);
  }

  /** Children of the root and of Inkscape layers: what a click or marquee selects. */
  topLevel(): NodeId[] {
    const out: NodeId[] = [];
    const walk = (id: NodeId) => {
      for (const c of this.getNode(id).children) {
        const n = this.getNode(c);
        if (n.tag === TEXT_TAG) continue;
        if (n.tag === "g" && n.attrs["inkscape:groupmode"] === "layer") walk(c);
        else out.push(c);
      }
    };
    walk(this.root);
    return out;
  }

  /**
   * Bounding box. `space: "local"` (default) is the element's own user space
   * (like DOM getBBox); `"root"` includes its and its ancestors' transforms.
   * Computed headlessly for basic shapes and groups of them; paths and text
   * use the measure bridge when one is set. Throws BBOX_UNAVAILABLE otherwise.
   */
  getBBox(id: NodeId, space: "local" | "root" = "local"): BBox {
    this.getNode(id);
    const b = this.tryBBox(id, space);
    if (b) return b;
    const r = this.m.getBBox(id);
    const reason = r.ok ? "" : r.error.message;
    throw new SvgEditorError("BBOX_UNAVAILABLE", `Cannot measure "${id}". ${reason}`.trim(), "Paths and text need a renderer: in the desktop app this works; headless, pass `measure` to createEditor().");
  }

  /** @internal Like getBBox, but null instead of throwing. */
  tryBBox(id: NodeId, space: "local" | "root"): BBox | null {
    if (space === "root") {
      const measured = this.editor.measure(id);
      if (measured) return measured;
    }
    const r = this.m.getBBox(id);
    if (!r.ok) return null;
    if (space === "local") return r.result;
    return transformBBox(this.toRootMatrix(id), r.result);
  }

  /** Element user space -> root user space (its own and its ancestors' transforms). */
  private toRootMatrix(id: NodeId): Matrix {
    let m: Matrix = IDENTITY;
    for (let cur: NodeId | null = id; cur !== null && cur !== this.root; cur = this.getNode(cur).parent) {
      const t = parseTransform(this.getNode(cur).attrs.transform) ?? IDENTITY;
      m = multiply(t, m);
    }
    return m;
  }

  /**
   * Moves an element by (dx, dy) in root user units, converting through its
   * ancestors' transforms (for align / distribute on nested elements).
   */
  translateInRoot(id: NodeId, [dx, dy]: Vec2): string {
    const parent = this.getNode(id).parent;
    const m = parent && parent !== this.root ? this.toRootMatrix(parent) : IDENTITY;
    const det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-12) {
      throw new SvgEditorError("INVALID_TRANSFORM", `An ancestor of "${id}" collapses it (scale 0), so it cannot be moved in root units.`, "Fix the ancestor's transform first.");
    }
    const px = (m[3] * dx - m[2] * dy) / det;
    const py = (-m[1] * dx + m[0] * dy) / det;
    return this.transform(id, { translate: [px, py] });
  }

  /** Maps a point from an element's user space to root user space. */
  pointToRoot(id: NodeId, p: Vec2): Vec2 {
    return applyToPoint(this.toRootMatrix(id), p);
  }
}

function notFound(id: NodeId): SvgEditorError {
  return new SvgEditorError("NOT_FOUND", `No node with id "${id}".`, "Call doc.query() or doc.getTree() to list current node IDs.");
}

function toString(v: AttrValue): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new SvgEditorError("INVALID_ATTR", `Attribute value ${v} is not a finite number.`, "Pass a finite number or a string.");
    return formatNumber(v);
  }
  if (typeof v !== "string") throw new SvgEditorError("INVALID_ATTR", `Attribute value must be a string or number, got ${typeof v}.`, "Pass a string or number.");
  return v;
}

function toStrings(attrs: Record<string, AttrValue>): Record<string, string> {
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, toString(v)]));
}

function stoppedError(): SvgEditorError {
  return new SvgEditorError("LOCK_STOPPED", "The lock session was stopped before it finished; its changes were rolled back unless kept.", "Check session.signal.aborted in long-running work and return early.");
}

/**
 * A lock session: the only writer while it lasts. `doc` and `execute` work
 * like the editor's; after the session ends they throw LOCK_RELEASED.
 */
export class LockSession {
  readonly doc: DocumentApi;

  /** @internal Use editor.lock() or editor.runLocked(). */
  constructor(
    private readonly editor: Editor,
    private readonly token: object,
    readonly info: LockInfo,
    /** Aborted when the session is stopped (pass it to fetch() so the request is cancelled too). */
    readonly signal: AbortSignalLike,
  ) {
    this.doc = new DocumentApi(editor, token);
  }

  get active(): boolean {
    return this.editor.lockInfo !== null && this.editorToken() === this.token;
  }

  get stopped(): boolean {
    return this.signal.aborted;
  }

  execute(cmd: unknown): ExecuteResult {
    return this.editor.executeAs(this.token, cmd);
  }

  /** Several changes inside the session, rolled back together if `fn` throws. */
  batch<T>(fn: () => T): T {
    return this.editor.transactionAs(this.token, fn);
  }

  /** Keeps the changes (one undo step) and unlocks. */
  commit(): LockOutcome {
    return this.end(true, false);
  }

  /** Discards the changes and unlocks. */
  rollback(): LockOutcome {
    return this.end(false, false);
  }

  /** Aborts `signal`, then discards (default) or keeps the partial work, and unlocks. */
  stop(options: { keep?: boolean } = {}): LockOutcome {
    return this.end(options.keep ?? false, true);
  }

  private end(keep: boolean, stopped: boolean): LockOutcome {
    const r = this.editor.release(this.token, keep, stopped);
    if (!r) throw new SvgEditorError("LOCK_RELEASED", "This lock session has already ended.", "Start a new session with editor.lock().");
    return r;
  }

  private editorToken(): object | null {
    try {
      this.editor.gate(this.token);
      return this.token;
    } catch {
      return null;
    }
  }
}
