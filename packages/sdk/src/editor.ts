import {
  applyToPoint,
  formatNumber,
  IDENTITY,
  multiply,
  parseTransform,
  TEXT_TAG,
  transformBBox,
  type BBox,
  type Command,
  type CommandResult,
  type CommandResultMap,
  type Matrix,
  type NodeData,
  type NodeId,
  type Query,
  type SerializeOptions,
  type TreeNode,
  type Vec2,
} from "@svg-editor/model";
import { openSvg, type SourceDocument, type TextEdit } from "@svg-editor/parser";
import { SvgEditorError } from "./errors.js";

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

  /** @internal Use createEditor(). */
  constructor(
    private readonly source: SourceDocument,
    bridges: Bridges = {},
  ) {
    this.bridges = { rasterize: bridges.rasterize, measure: bridges.measure };
    this.doc = new DocumentApi(this);
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

  /** Source offsets of a node's text (for highlighting it in a code view). */
  getSourceRange(id: NodeId): { start: number; end: number } | undefined {
    return this.source.getSource(id);
  }

  /** The deepest element at a source offset (for "cursor in code selects node"). */
  nodeAt(offset: number): NodeId | undefined {
    return this.source.nodeAt(offset);
  }

  // -------------------------------------------------------------- history

  undo(): boolean {
    return this.model.undo();
  }

  redo(): boolean {
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
    return this.model.transaction(fn);
  }

  /** Starts a batch that can span `await`s (e.g. a whole AI turn). Call commit() or rollback(). */
  beginBatch(): { commit(): void; rollback(): void } {
    return this.model.beginTransaction();
  }

  /**
   * Runs a serializable command without throwing: `{ ok, result }` or
   * `{ ok: false, error: { code, message, hint } }`. This is the form the
   * AI tool dispatcher uses.
   */
  execute<C extends Command>(cmd: C): CommandResult<CommandResultMap[C["op"]]>;
  execute(cmd: unknown): CommandResult;
  execute(cmd: unknown): CommandResult {
    return this.model.execute(cmd);
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

  /** PNG bytes. Needs a rasterizer bridge (the desktop app has one; headless scripts can plug one in). */
  async exportPng(options: { scale?: number } = {}): Promise<Uint8Array> {
    const rasterize = this.bridges.rasterize;
    if (!rasterize) {
      throw new SvgEditorError("NO_RASTERIZER", "No rasterizer is available to draw PNGs.", "Pass `rasterize` to createEditor() or setBridges(); in the desktop app it is set up for you.");
    }
    const scale = options.scale ?? 1;
    const size = this.intrinsicSize();
    let svg = this.toSvg();
    if (!/^<svg[^>]*\sxmlns=/.test(svg)) svg = svg.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    try {
      return await rasterize(svg, { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) });
    } catch (e) {
      throw new SvgEditorError("EXPORT_FAILED", `PNG export failed: ${(e as Error).message}`, "Check that the drawing renders; external images are not loaded.");
    }
  }

  /** @internal */
  measure(id: NodeId): BBox | null {
    return this.bridges.measure?.(id) ?? null;
  }
}

/** Document commands and queries. Write methods throw SvgEditorError; they never half-apply. */
export class DocumentApi {
  constructor(private readonly editor: Editor) {}

  private get m() {
    return this.editor.model;
  }

  private run<C extends Command>(cmd: C): CommandResultMap[C["op"]] {
    const r = this.m.execute(cmd);
    if (!r.ok) throw SvgEditorError.fromCommand(r.error);
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
    return this.editor.batch(() => {
      const id = this.add("text", attrs, at);
      this.setText(id, text);
      return id;
    });
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
