import { formatPath, movePathPoints, nearestOnPath, oppositeHandle, pointOnSegment, type BBox, type Command, type Editor, type NodeId, type PathMove, type PathNodeOp, type PathPoint, type PathSegment } from "@svg-editor/sdk";
import {
  angleBetween,
  anchorPoint,
  apply,
  applyLinear,
  boundsOf,
  corners,
  HANDLES,
  invert,
  mat,
  rectFromPoints,
  resizeScale,
  round,
  snap,
  type Handle,
  type Mat,
  type Point,
  type Rect,
} from "./geometry.js";
import { renderTree } from "./render.js";

export type Tool = "select" | "rect" | "ellipse" | "line" | "text";

const SVG_NS = "http://www.w3.org/2000/svg";
const DRAG_THRESHOLD = 3;
/** How close (screen px) an edge or centre must come to another shape's to snap to it. */
const SNAP_PX = 6;
const ROTATE_OFFSET = 24;
const DRAW_STYLE = { fill: "#93c5fd", stroke: "#1e3a8a", "stroke-width": "1" };

/** Elements that draw something and can be selected on the canvas. */
const GRAPHIC = new Set(["g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "image", "use", "svg", "foreignObject", "a", "switch"]);

type Gesture =
  | { kind: "move"; start: Point; items: Item[]; moved: boolean; box?: Rect; targets?: Rect[] }
  | { kind: "resize"; handle: Handle; items: Item[]; box: Rect; local: boolean }
  | { kind: "rotate"; center: Point; start: Point; items: Item[] }
  | { kind: "marquee"; start: Point; additive: boolean; rect: SVGRectElement }
  | { kind: "draw"; tool: Exclude<Tool, "select" | "text">; start: Point; el: SVGElement }
  | { kind: "pan"; start: Point; scroll: Point }
  | { kind: "node"; id: NodeId; el: SVGGraphicsElement; segs: PathSegment[]; seg: number; point: PathPoint; inv: Mat; original: string | null; move?: PathMove; handles: boolean };

/** Grid snapping, provided by the viewport. */
export interface Snapper {
  readonly snapping: boolean;
  snapRoot(p: Point): Point;
}

/** A selected element during a gesture, with what is needed to preview and commit. */
interface Item {
  id: NodeId;
  el: SVGGraphicsElement;
  original: string | null;
  parentInv: Mat;
  /** Element user space -> screen. */
  ctm: Mat;
  bbox: Rect;
  preview?: string;
  command?: Command;
}

/**
 * Canvas interaction: selection, handles, gestures and drawing tools. Every
 * change goes to the model as one command (a batch for multi-selection), sent
 * when the gesture ends; while dragging, only the DOM is previewed. So one
 * gesture is one undo step and the code pane gets one minimal patch.
 */
export class CanvasController {
  private svg: SVGSVGElement | null = null;
  private nodeOf = new WeakMap<Element, NodeId>();
  private elOf = new Map<NodeId, SVGGraphicsElement>();
  private gesture: Gesture | null = null;
  private _tool: Tool = "select";
  private textInput: HTMLInputElement | null = null;
  private spaceDown = false;
  snapper: Snapper = { snapping: false, snapRoot: (p) => p };
  private unsubscribe: () => void;
  /** Node editing: the path whose points are shown and draggable. */
  private nodeEdit: NodeId | null = null;
  /** Told when node editing starts or ends (for a status hint). */
  onNodeEdit: (editing: boolean) => void = () => {};
  /** The selected point while editing nodes (its segment index), for Delete and node / segment types. */
  private activeNode: number | null = null;
  /** Told when the selected point changes: its index and whether it is smooth, or null. */
  onActiveNode: (node: { seg: number; smooth: boolean; isStart: boolean } | null) => void = () => {};
  /** Snap moved shapes to other shapes' and the page's edges and centres (with guide lines). */
  snapShapes = true;
  /** Guide lines of the current shape snap, in screen space. */
  private guides: { x?: { at: number; from: number; to: number }; y?: { at: number; from: number; to: number } } | null = null;
  /** An element pointed at elsewhere (code pane, layers), outlined without selecting it. */
  private hover: NodeId | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly overlay: SVGSVGElement,
    private editor: Editor,
    private readonly onTool: (tool: Tool) => void,
  ) {
    this.unsubscribe = editor.onSelectionChange(() => this.selectionChanged());
    host.addEventListener("dblclick", (e) => this.doubleClick(e));
    overlay.addEventListener("dblclick", (e) => this.doubleClick(e));
    host.addEventListener("keyup", (e) => {
      if (e.key === " ") this.spaceDown = false;
    });
    host.addEventListener("pointerdown", (e) => this.pointerDown(e));
    overlay.addEventListener("pointerdown", (e) => this.pointerDown(e));
    window.addEventListener("pointermove", (e) => this.pointerMove(e));
    window.addEventListener("pointerup", (e) => this.pointerUp(e));
    host.addEventListener("keydown", (e) => this.keyDown(e));
    new ResizeObserver(() => this.drawOverlay()).observe(host);
    host.addEventListener("scroll", () => this.drawOverlay());
  }

  /** Switches to another document (after Open / New). Gestures reset. */
  setEditor(editor: Editor): void {
    this.cancelGesture();
    this.closeText();
    this.unsubscribe();
    this.exitNodeEdit();
    this.editor = editor;
    this.unsubscribe = editor.onSelectionChange(() => this.selectionChanged());
    this.render();
  }

  /** The selection lives in the SDK editor; the canvas only draws it. */
  private get selection(): NodeId[] {
    return this.editor.getSelection();
  }

  /** Abandons any gesture or text entry in progress (e.g. when the document gets locked). */
  interrupt(): void {
    this.cancelGesture();
    this.closeText();
    this.exitNodeEdit();
  }

  // ------------------------------------------------------------ node editing

  get editingNodes(): NodeId | null {
    return this.nodeEdit;
  }

  /** Shows the points of a <path> for dragging. Returns false if `id` is not an editable path. */
  editNodes(id: NodeId): boolean {
    if (!this.editor.doc.has(id) || this.editor.doc.getNode(id).tag !== "path") return false;
    try {
      this.editor.doc.getPath(id);
    } catch {
      return false; // unreadable path data
    }
    this.nodeEdit = id;
    this.setActiveNode(null);
    if (this.selection.length !== 1 || this.selection[0] !== id) this.select([id]);
    this.onNodeEdit(true);
    this.drawOverlay();
    return true;
  }

  exitNodeEdit(): void {
    if (this.nodeEdit === null) return;
    this.nodeEdit = null;
    this.setActiveNode(null);
    this.onNodeEdit(false);
    this.drawOverlay();
  }

  private selectionChanged(): void {
    const sel = this.selection;
    if (this.nodeEdit !== null && (sel.length !== 1 || sel[0] !== this.nodeEdit)) this.exitNodeEdit();
    this.drawOverlay();
  }

  private setActiveNode(seg: number | null): void {
    this.activeNode = seg;
    if (seg === null || this.nodeEdit === null) return this.onActiveNode(null);
    const segs = this.editor.doc.getPath(this.nodeEdit);
    this.onActiveNode({ seg, smooth: isSmooth(segs, seg), isStart: segs[seg]?.cmd === "M" });
  }

  /**
   * Node-level change on the edited path: "delete", "corner"/"smooth" apply to the selected
   * point, "line"/"curve" to the segment that ends at it. One undo step.
   */
  nodeAction(action: "delete" | "corner" | "smooth" | "line" | "curve"): void {
    const id = this.nodeEdit;
    const seg = this.activeNode;
    if (id === null || seg === null) return;
    const op: PathNodeOp =
      action === "delete" ? { action, seg } : action === "corner" || action === "smooth" ? { action: "node", seg, type: action } : { action: "segment", seg, type: action };
    const at = this.editor.doc.getPath(id)[seg];
    const r = this.editor.execute({ op: "pathNode", id, ...op });
    if (!r.ok) {
      this.onNodeError(r.error.message);
      return;
    }
    // Indices can shift (an arc becomes several curves); keep the same point selected.
    this.setActiveNode(action === "delete" || !at || at.cmd === "Z" ? null : this.nodeAtPoint(id, at.p));
    this.drawOverlay();
  }
  /** Told when a node action is refused (for the status bar). */
  onNodeError: (message: string) => void = () => {};

  private nodeAtPoint(id: NodeId, p: [number, number]): number | null {
    const segs = this.editor.doc.getPath(id);
    const i = segs.findIndex((s) => s.cmd !== "Z" && Math.abs(s.p[0] - p[0]) < 1e-6 && Math.abs(s.p[1] - p[1]) < 1e-6);
    return i < 0 ? null : i;
  }

  /** The spot on the edited path's outline within 8 screen px of a pointer event, if any. */
  private nearOutline(e: MouseEvent): { seg: number; t: number } | null {
    const id = this.nodeEdit;
    const ctm = id !== null ? this.elOf.get(id)?.getScreenCTM() : null;
    if (id === null || !ctm) return null;
    const m = mat(ctm);
    const local = apply(invert(m), { x: e.clientX, y: e.clientY });
    const hit = nearestOnPath(this.editor.doc.getPath(id), [local.x, local.y]);
    if (!hit) return null;
    const onScreen = apply(m, { x: hit.point[0], y: hit.point[1] });
    return Math.hypot(onScreen.x - e.clientX, onScreen.y - e.clientY) <= 8 ? { seg: hit.seg, t: hit.t } : null;
  }

  private doubleClick(e: MouseEvent): void {
    if (this._tool !== "select") return;
    if (this.nodeEdit !== null) {
      // On a point: toggle corner / smooth. On the outline: add a point there.
      const ref = e.target instanceof Element ? e.target.getAttribute("data-node") : null;
      if (ref?.endsWith(":p")) {
        const seg = Number(ref.split(":")[0]);
        this.setActiveNode(seg);
        this.nodeAction(isSmooth(this.editor.doc.getPath(this.nodeEdit), seg) ? "corner" : "smooth");
        return;
      }
      const spot = this.nearOutline(e);
      if (spot && spot.t > 0.001 && spot.t < 0.999) {
        const id = this.nodeEdit;
        // Like a drag, the new point lands on 2 decimals (its handles follow; the outline moves < 0.005).
        const at = pointOnSegment(this.editor.doc.getPath(id), spot.seg, spot.t);
        const r = this.editor.execute({
          op: "batch",
          commands: [
            { op: "pathNode", id, action: "insert", seg: spot.seg, t: spot.t },
            { op: "pathEdit", id, moves: [{ seg: spot.seg, point: "p", to: [round(at[0]), round(at[1])] }] },
          ],
        });
        if (r.ok) this.setActiveNode(spot.seg);
        this.drawOverlay();
        return;
      }
    }
    const hit = this.pick(e.target, true);
    if (hit && this.editor.doc.getNode(hit).tag === "path") this.editNodes(hit);
  }

  /** Node and control-point positions of the edited path, in screen space. */
  private drawNodes(o: SVGSVGElement, local: (p: Point) => Point): void {
    const id = this.nodeEdit!;
    const el = this.elOf.get(id);
    const ctm = el?.getScreenCTM();
    let segs: PathSegment[];
    try {
      segs = this.gesture?.kind === "node" && this.gesture.move ? movePathPoints(this.gesture.segs, [this.gesture.move], this.gesture.handles) : this.editor.doc.getPath(id);
    } catch {
      this.exitNodeEdit();
      return;
    }
    if (!el || !ctm) return;
    const m = mat(ctm);
    const s = (v: [number, number]) => local(apply(m, { x: v[0], y: v[1] }));
    const line = (a: Point, b: Point) => o.appendChild(svgEl("line", { class: "ctrl-line", x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
    const ctrl = (seg: number, point: PathPoint, at: Point) => o.appendChild(svgEl("circle", { class: "handle ctrl", "data-node": `${seg}:${point}`, cx: at.x, cy: at.y, r: 4 }));
    let prev: Point | null = null;
    let start: Point | null = null;
    const nodes: [number, Point][] = [];
    segs.forEach((seg, i) => {
      if (seg.cmd === "Z") {
        prev = start;
        return;
      }
      const end = s(seg.p);
      if (seg.cmd === "M") start = end;
      if (seg.cmd === "C") {
        const c1 = s(seg.c1);
        const c2 = s(seg.c2);
        if (prev) line(prev, c1);
        line(end, c2);
        ctrl(i, "c1", c1);
        ctrl(i, "c2", c2);
      } else if (seg.cmd === "Q") {
        const c = s(seg.c);
        if (prev) line(prev, c);
        line(end, c);
        ctrl(i, "c", c);
      }
      nodes.push([i, end]);
      prev = end;
    });
    for (const [i, p] of nodes) o.appendChild(svgEl("rect", { class: i === this.activeNode ? "handle node active" : "handle node", "data-node": `${i}:p`, x: p.x - 4, y: p.y - 4, width: 8, height: 8 }));
  }

  private startNodeDrag(ref: string): void {
    const id = this.nodeEdit;
    const el = id ? this.elOf.get(id) : undefined;
    const ctm = el?.getScreenCTM();
    if (!id || !el || !ctm) return;
    const [seg, point] = ref.split(":") as [string, PathPoint];
    if (point === "p") this.setActiveNode(Number(seg));
    this.gesture = { kind: "node", id, el, segs: this.editor.doc.getPath(id), seg: Number(seg), point, inv: invert(mat(ctm)), original: el.getAttribute("d"), handles: true };
  }

  /** Redraws selection outlines (after zoom or scroll). */
  refresh(): void {
    this.drawOverlay();
  }

  get tool(): Tool {
    return this._tool;
  }

  setTool(tool: Tool): void {
    this._tool = tool;
    this.host.dataset.tool = tool;
    this.onTool(tool);
  }

  private select(ids: NodeId[]): void {
    this.editor.select(ids.filter((id) => this.editor.doc.has(id)));
  }

  /**
   * Measure bridge for the SDK: an element's bounding box in root user
   * units, from the live DOM (works for paths and text, unlike headless).
   */
  measure(id: NodeId): BBox | null {
    const el = this.elOf.get(id);
    const rootCtm = this.svg?.getScreenCTM();
    const ctm = el?.getScreenCTM();
    if (!el || !rootCtm || !ctm) return null;
    try {
      const b = el.getBBox();
      const toRoot = invert(mat(rootCtm));
      const r = boundsOf(corners({ x: b.x, y: b.y, width: b.width, height: b.height }).map((p) => apply(toRoot, apply(mat(ctm), p))));
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    } catch {
      return null;
    }
  }

  /** Rebuilds the canvas from the model and keeps the selection where possible. */
  render(): void {
    const { svg, nodeOf } = renderTree(this.editor.doc.getTree());
    this.svg = svg;
    this.nodeOf = nodeOf;
    this.elOf.clear();
    const walk = (el: Element) => {
      const id = nodeOf.get(el);
      if (id !== undefined && el instanceof SVGGraphicsElement) this.elOf.set(id, el);
      for (const c of Array.from(el.children)) walk(c);
    };
    walk(svg);
    this.host.replaceChildren(svg);
    // The document changed (an undo, a drag): refresh what the inspector shows for the selected point.
    if (this.nodeEdit !== null && this.activeNode !== null) {
      try {
        const n = this.editor.doc.getPath(this.nodeEdit).length;
        this.setActiveNode(this.activeNode < n ? this.activeNode : null);
      } catch {
        this.setActiveNode(null);
      }
    }
    this.drawOverlay();
  }

  // ------------------------------------------------------------ commands

  private run(commands: Command[]): void {
    if (commands.length === 0) return;
    const r = this.editor.execute(commands.length === 1 ? commands[0]! : { op: "batch", commands });
    if (!r.ok) console.warn("canvas command failed", r.error);
  }

  deleteSelection(): void {
    if (this.selection.length === 0) return;
    this.run([{ op: "delete", ids: this.selection }]);
  }

  nudge(dx: number, dy: number): void {
    this.run(this.selection.map((id) => ({ op: "transform", id, translate: [dx, dy] }) satisfies Command));
  }

  // ------------------------------------------------------------ geometry

  private screenPoint(e: PointerEvent | MouseEvent): Point {
    return { x: e.clientX, y: e.clientY };
  }

  private itemFor(id: NodeId): Item | null {
    const el = this.elOf.get(id);
    if (!el) return null;
    const ctm = el.getScreenCTM();
    const parent = el.parentElement as unknown as SVGGraphicsElement | null;
    const parentCtm = parent && "getScreenCTM" in parent ? parent.getScreenCTM() : null;
    if (!ctm || !parentCtm) return null;
    let bbox: Rect;
    try {
      const b = el.getBBox();
      bbox = { x: b.x, y: b.y, width: b.width, height: b.height };
    } catch {
      return null;
    }
    try {
      return { id, el, original: el.getAttribute("transform"), parentInv: invert(mat(parentCtm)), ctm: mat(ctm), bbox };
    } catch {
      return null;
    }
  }

  private screenCorners(item: Item): Point[] {
    return corners(item.bbox).map((p) => apply(item.ctm, p));
  }

  /** The selectable node for a DOM target: topmost below the root or a layer, or the deepest with Ctrl/Cmd. */
  private pick(target: EventTarget | null, deep: boolean): NodeId | null {
    let el = target instanceof Element ? target : null;
    const chain: NodeId[] = [];
    while (el && el !== this.svg) {
      const id = this.nodeOf.get(el);
      if (id !== undefined && GRAPHIC.has(el.localName)) chain.push(id);
      el = el.parentElement;
    }
    if (chain.length === 0) return null;
    if (deep) return chain[0]!;
    const doc = this.editor.doc;
    for (let i = chain.length - 1; i >= 0; i--) {
      const parent = doc.getNode(doc.getNode(chain[i]!).parent!);
      if (parent.id === doc.root || isLayer(parent.attrs)) {
        if (!isLayer(doc.getNode(chain[i]!).attrs)) return chain[i]!;
      }
    }
    return chain[0]!;
  }

  // ------------------------------------------------------------- overlay

  /** Outlines `id` on the canvas as a hover hint; null clears it. */
  setHover(id: NodeId | null): void {
    if (id === this.hover) return;
    this.hover = id;
    this.drawOverlay();
  }

  private drawHover(o: SVGSVGElement, local: (p: Point) => Point): void {
    const id = this.hover;
    if (id === null || this.gesture || this.selection.includes(id) || !this.editor.doc.has(id)) return;
    const item = this.itemFor(id);
    if (!item) return;
    const pts = this.screenCorners(item).map(local);
    o.appendChild(svgEl("polygon", { class: "hover-outline", points: pts.map((p) => `${p.x},${p.y}`).join(" ") }));
  }

  private drawOverlay(): void {
    const o = this.overlay;
    const origin = o.getBoundingClientRect();
    const local = (p: Point): Point => ({ x: p.x - origin.left, y: p.y - origin.top });
    const keep = this.gesture?.kind === "marquee" ? this.gesture.rect : null;
    o.replaceChildren(...(keep ? [keep] : []));
    if (this.nodeEdit !== null) {
      this.drawNodes(o, local);
      return;
    }
    this.drawHover(o, local);
    const gd = this.guides;
    if (gd?.x) { const a = local({ x: gd.x.at, y: gd.x.from }); const b = local({ x: gd.x.at, y: gd.x.to }); o.appendChild(svgEl("line", { class: "snap-guide", x1: a.x, y1: a.y - 8, x2: b.x, y2: b.y + 8 })); }
    if (gd?.y) { const a = local({ x: gd.y.from, y: gd.y.at }); const b = local({ x: gd.y.to, y: gd.y.at }); o.appendChild(svgEl("line", { class: "snap-guide", x1: a.x - 8, y1: a.y, x2: b.x + 8, y2: b.y })); }
    const items = this.selection.map((id) => this.itemFor(id)).filter((i): i is Item => i !== null);
    if (items.length === 0 || this.gesture?.kind === "draw") return;

    for (const item of items) {
      const pts = this.screenCorners(item).map(local);
      o.appendChild(svgEl("polygon", { class: "sel-outline", points: pts.map((p) => `${p.x},${p.y}`).join(" ") }));
    }
    // Handles: on the element's own box for one element, on the union for several.
    const box = items.length === 1 ? this.screenCorners(items[0]!).map(local) : corners(boundsOf(items.flatMap((i) => this.screenCorners(i)))).map(local);
    const [tl, tr, br, bl] = box as [Point, Point, Point, Point];
    const at = (fx: number, fy: number): Point => {
      const top = { x: tl.x + (tr.x - tl.x) * fx, y: tl.y + (tr.y - tl.y) * fx };
      const bottom = { x: bl.x + (br.x - bl.x) * fx, y: bl.y + (br.y - bl.y) * fx };
      return { x: top.x + (bottom.x - top.x) * fy, y: top.y + (bottom.y - top.y) * fy };
    };
    if (items.length > 1) {
      o.appendChild(svgEl("polygon", { class: "sel-group", points: box.map((p) => `${p.x},${p.y}`).join(" ") }));
    }
    const topMid = at(0.5, 0);
    const center = at(0.5, 0.5);
    const len = Math.hypot(topMid.x - center.x, topMid.y - center.y) || 1;
    const rot = { x: topMid.x + ((topMid.x - center.x) / len) * ROTATE_OFFSET, y: topMid.y + ((topMid.y - center.y) / len) * ROTATE_OFFSET };
    o.appendChild(svgEl("line", { class: "sel-stem", x1: topMid.x, y1: topMid.y, x2: rot.x, y2: rot.y }));
    o.appendChild(svgEl("circle", { class: "handle rotate", "data-handle": "rotate", cx: rot.x, cy: rot.y, r: 5 }));
    for (const h of HANDLES) {
      const f = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] }[h] as [number, number];
      const p = at(f[0], f[1]);
      o.appendChild(svgEl("rect", { class: `handle ${h}`, "data-handle": h, x: p.x - 4, y: p.y - 4, width: 8, height: 8 }));
    }
  }

  // ------------------------------------------------------------ pointer

  private pointerDown(e: PointerEvent): void {
    const p = this.screenPoint(e);
    // Pan: middle button, or Space + drag.
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      e.preventDefault();
      this.gesture = { kind: "pan", start: p, scroll: { x: this.host.scrollLeft, y: this.host.scrollTop } };
      return;
    }
    if (e.button !== 0) return;
    if (this.textInput) this.commitText();
    this.host.focus({ preventScroll: true });
    const node = e.target instanceof Element ? e.target.getAttribute("data-node") : null;
    if (node && this.nodeEdit !== null) {
      e.preventDefault();
      this.startNodeDrag(node);
      return;
    }
    const handle = e.target instanceof Element ? e.target.getAttribute("data-handle") : null;
    if (handle && this.selection.length > 0) {
      e.preventDefault();
      this.startHandle(handle, p);
      return;
    }
    if (this._tool === "text") {
      e.preventDefault();
      this.openTextInput(p);
      return;
    }
    if (this._tool !== "select") {
      e.preventDefault();
      this.startDraw(this._tool, p);
      return;
    }
    // Near the outline counts as on the path, so a double-click can add a point to a thin stroke.
    if (this.nodeEdit !== null && this.pick(e.target, true) !== this.nodeEdit && !this.nearOutline(e)) this.exitNodeEdit();
    if (this.nodeEdit !== null) {
      e.preventDefault();
      this.setActiveNode(null);
      this.drawOverlay();
      return; // clicks on the edited path itself only clear the point selection; drag its points
    }
    const hit = this.pick(e.target, e.ctrlKey || e.metaKey);
    if (hit) {
      e.preventDefault();
      if (e.shiftKey) {
        this.select(this.selection.includes(hit) ? this.selection.filter((s) => s !== hit) : [...this.selection, hit]);
        return;
      }
      if (!this.selection.includes(hit)) this.select([hit]);
      const items = this.selection.map((id) => this.itemFor(id)).filter((i): i is Item => i !== null);
      this.gesture = { kind: "move", start: p, items, moved: false };
      return;
    }
    if (e.target !== this.host && !(e.target instanceof Element && this.svg?.contains(e.target))) return;
    e.preventDefault();
    if (!e.shiftKey) this.select([]);
    const rect = svgEl("rect", { class: "marquee", x: 0, y: 0, width: 0, height: 0 }) as SVGRectElement;
    this.overlay.appendChild(rect);
    this.gesture = { kind: "marquee", start: p, additive: e.shiftKey, rect };
  }

  private startHandle(handle: string, p: Point): void {
    const items = this.selection.map((id) => this.itemFor(id)).filter((i): i is Item => i !== null);
    if (items.length === 0) return;
    const screenBox = boundsOf(items.flatMap((i) => this.screenCorners(i)));
    if (handle === "rotate") {
      const center = items.length === 1 ? apply(items[0]!.ctm, { x: items[0]!.bbox.x + items[0]!.bbox.width / 2, y: items[0]!.bbox.y + items[0]!.bbox.height / 2 }) : { x: screenBox.x + screenBox.width / 2, y: screenBox.y + screenBox.height / 2 };
      this.gesture = { kind: "rotate", center, start: p, items };
      return;
    }
    // One element: resize along its own axes (local space). Several: screen-aligned box.
    const local = items.length === 1;
    this.gesture = { kind: "resize", handle: handle as Handle, items, box: local ? items[0]!.bbox : screenBox, local };
  }

  private startDraw(tool: Exclude<Tool, "select" | "text">, p: Point): void {
    if (!this.svg) return;
    const tag = tool === "rect" ? "rect" : tool === "ellipse" ? "ellipse" : "line";
    const el = svgEl(tag, tool === "line" ? { stroke: DRAW_STYLE.stroke, "stroke-width": "2" } : { ...DRAW_STYLE });
    this.svg.appendChild(el);
    this.gesture = { kind: "draw", tool, start: this.snapper.snapRoot(this.toRoot(p)), el };
    this.select([]);
  }

  /** Adjusts a screen drag so the selection's top-left corner lands on the grid. */
  private snapDelta(items: Item[], d: Point): Point {
    if (items.length === 0 || !this.svg) return d;
    const topLeft = boundsOf(items.flatMap((i) => this.screenCorners(i)));
    const from = this.toRoot({ x: topLeft.x, y: topLeft.y });
    const to = this.snapper.snapRoot(this.toRoot({ x: topLeft.x + d.x, y: topLeft.y + d.y }));
    const ctm = this.svg.getScreenCTM();
    return ctm ? applyLinear(mat(ctm), { x: to.x - from.x, y: to.y - from.y }) : d;
  }

  /**
   * Shape snapping for a move: the selection's left / centre / right (top / middle / bottom)
   * within SNAP_PX of another shape's or the page's is pulled onto it, and a guide shows where.
   * `only` limits it to one axis (Shift keeps a move straight).
   */
  private snapToShapes(g: Extract<Gesture, { kind: "move" }>, d: Point, only: "x" | "y" | null): Point {
    if (!g.box) g.box = boundsOf(g.items.flatMap((i) => this.screenCorners(i)));
    if (!g.targets) g.targets = this.snapTargets(g.items.map((i) => i.id));
    const b = { x: g.box.x + d.x, y: g.box.y + d.y, width: g.box.width, height: g.box.height };
    const best = (mine: number[], theirs: (r: Rect) => number[]) => {
      let hit: { diff: number; at: number; r: Rect } | null = null;
      for (const r of g.targets!) for (const t of theirs(r)) for (const m of mine) {
        const diff = t - m;
        if (Math.abs(diff) <= SNAP_PX && (!hit || Math.abs(diff) < Math.abs(hit.diff))) hit = { diff, at: t, r };
      }
      return hit;
    };
    const hx = only === "y" ? null : best([b.x, b.x + b.width / 2, b.x + b.width], (r) => [r.x, r.x + r.width / 2, r.x + r.width]);
    const hy = only === "x" ? null : best([b.y, b.y + b.height / 2, b.y + b.height], (r) => [r.y, r.y + r.height / 2, r.y + r.height]);
    const out = { x: d.x + (hx?.diff ?? 0), y: d.y + (hy?.diff ?? 0) };
    const moved = { x: g.box.x + out.x, y: g.box.y + out.y };
    this.guides = hx || hy ? {} : null;
    if (hx) this.guides!.x = { at: hx.at, from: Math.min(moved.y, hx.r.y), to: Math.max(moved.y + b.height, hx.r.y + hx.r.height) };
    if (hy) this.guides!.y = { at: hy.at, from: Math.min(moved.x, hy.r.x), to: Math.max(moved.x + b.width, hy.r.x + hy.r.width) };
    return out;
  }

  /** Screen boxes of every shape a move can snap to (not the moved ones, their groups or contents), and the page. */
  private snapTargets(moving: NodeId[]): Rect[] {
    const doc = this.editor.doc;
    const related = (id: NodeId) =>
      moving.some((m) => {
        for (let a: NodeId | null = m; a !== null; a = doc.getNode(a).parent ?? null) if (a === id) return true; // an ancestor
        for (let a: NodeId | null = id; a !== null; a = doc.getNode(a).parent ?? null) if (a === m) return true; // inside it
        return false;
      });
    const out: Rect[] = [];
    for (const [id, el] of this.elOf) {
      if (id === doc.root || !doc.has(id) || related(id)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
    }
    const page = this.svg?.getBoundingClientRect();
    if (page) out.push({ x: page.left, y: page.top, width: page.width, height: page.height });
    return out;
  }

  private toRoot(p: Point): Point {
    const ctm = this.svg?.getScreenCTM();
    return ctm ? apply(invert(mat(ctm)), p) : p;
  }

  private pointerMove(e: PointerEvent): void {
    const g = this.gesture;
    if (!g) return;
    const p = this.screenPoint(e);
    if (g.kind === "pan") {
      this.host.scrollLeft = g.scroll.x - (p.x - g.start.x);
      this.host.scrollTop = g.scroll.y - (p.y - g.start.y);
      return;
    }
    if (g.kind === "node") {
      // Snap in drawing units, then into the path's own coordinates.
      const snapped = this.snapper.snapping && this.svg?.getScreenCTM() ? apply(mat(this.svg.getScreenCTM()!), this.snapper.snapRoot(this.toRoot(p))) : p;
      const q = apply(g.inv, snapped);
      g.handles = !e.altKey;
      g.move = { seg: g.seg, point: g.point, to: [round(q.x), round(q.y)] };
      g.el.setAttribute("d", formatPath(movePathPoints(g.segs, [g.move], g.handles)));
      this.drawOverlay();
      return;
    }
    switch (g.kind) {
      case "move": {
        const d = { x: p.x - g.start.x, y: p.y - g.start.y };
        if (!g.moved && Math.hypot(d.x, d.y) < DRAG_THRESHOLD) return;
        g.moved = true;
        let constrained = e.shiftKey ? (Math.abs(d.x) > Math.abs(d.y) ? { x: d.x, y: 0 } : { x: 0, y: d.y }) : d;
        if (this.snapper.snapping) constrained = this.snapDelta(g.items, constrained);
        if (this.snapShapes && !e.altKey) constrained = this.snapToShapes(g, constrained, e.shiftKey ? (constrained.x === 0 ? "y" : "x") : null);
        else this.guides = null;
        for (const it of g.items) {
          const v = applyLinear(it.parentInv, constrained);
          const t: [number, number] = [round(v.x), round(v.y)];
          it.command = { op: "transform", id: it.id, translate: t };
          it.preview = join(`translate(${t[0]} ${t[1]})`, it.original);
        }
        break;
      }
      case "resize": {
        for (const it of g.items) {
          if (g.local) {
            const q = apply(invert(it.ctm), p);
            const [sx, sy] = resizeScale(g.box, g.handle, q, e.shiftKey).map(roundScale) as [number, number];
            const a = anchorPoint(g.box, g.handle);
            const o: [number, number] = [round(a.x), round(a.y)];
            it.command = { op: "transform", id: it.id, scale: [sx, sy], origin: o, space: "local" };
            it.preview = join(it.original, `translate(${o[0]} ${o[1]}) scale(${sx} ${sy}) translate(${-o[0]} ${-o[1]})`);
          } else {
            const [sx, sy] = resizeScale(g.box, g.handle, p, e.shiftKey).map(roundScale) as [number, number];
            const a = apply(it.parentInv, anchorPoint(g.box, g.handle));
            const o: [number, number] = [round(a.x), round(a.y)];
            it.command = { op: "transform", id: it.id, scale: [sx, sy], origin: o };
            it.preview = join(`translate(${o[0]} ${o[1]}) scale(${sx} ${sy}) translate(${-o[0]} ${-o[1]})`, it.original);
          }
        }
        break;
      }
      case "rotate": {
        let deg = angleBetween(g.center, g.start, p);
        if (e.shiftKey) deg = snap(deg, 15);
        deg = round(deg);
        for (const it of g.items) {
          const c = apply(it.parentInv, g.center);
          const o: [number, number] = [round(c.x), round(c.y)];
          it.command = { op: "transform", id: it.id, rotate: deg, origin: o };
          it.preview = join(`rotate(${deg} ${o[0]} ${o[1]})`, it.original);
        }
        break;
      }
      case "marquee": {
        const origin = this.overlay.getBoundingClientRect();
        const r = rectFromPoints(g.start, p);
        setAttrs(g.rect, { x: r.x - origin.left, y: r.y - origin.top, width: r.width, height: r.height });
        return;
      }
      case "draw": {
        const q = this.snapper.snapRoot(this.toRoot(p));
        setAttrs(g.el, drawAttrs(g.tool, g.start, q, e.shiftKey));
        return;
      }
    }
    for (const it of g.items) {
      if (it.preview !== undefined) it.el.setAttribute("transform", it.preview);
    }
    this.drawOverlay();
  }

  private pointerUp(e: PointerEvent): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    this.guides = null;
    switch (g.kind) {
      case "pan":
        return;
      case "node": {
        if (!g.move) return;
        const r = this.editor.execute({ op: "pathEdit", id: g.id, moves: [g.move], handles: g.handles });
        if (!r.ok) {
          restoreD(g.el, g.original);
          console.warn("path edit failed", r.error);
        }
        this.drawOverlay();
        return;
      }
      case "move":
      case "resize":
      case "rotate": {
        const cmds = g.items.map((i) => i.command).filter((c): c is Command => c !== undefined);
        if (cmds.length === 0) return this.drawOverlay();
        this.run(cmds); // re-renders from the model
        return;
      }
      case "marquee": {
        g.rect.remove();
        const r = rectFromPoints(g.start, this.screenPoint(e));
        if (r.width < DRAG_THRESHOLD && r.height < DRAG_THRESHOLD) return;
        // Same path as a script: SDK selectInRect in root units (measured via the DOM bridge).
        const before = this.selection;
        const a = this.toRoot({ x: r.x, y: r.y });
        const b = this.toRoot({ x: r.x + r.width, y: r.y + r.height });
        const inside = this.editor.selectInRect(rectFromPoints(a, b));
        if (g.additive) this.select([...before, ...inside]);
        return;
      }
      case "draw": {
        g.el.remove();
        const q = this.snapper.snapRoot(this.toRoot(this.screenPoint(e)));
        const attrs = drawAttrs(g.tool, g.start, q, e.shiftKey);
        const size = g.tool === "line" ? Math.hypot(q.x - g.start.x, q.y - g.start.y) : Math.min(Number(attrs.width ?? attrs.rx), Number(attrs.height ?? attrs.ry));
        if (!(size > 0.5)) return;
        const tag = g.tool === "rect" ? "rect" : g.tool === "ellipse" ? "ellipse" : "line";
        const style: Record<string, string> = g.tool === "line" ? { stroke: DRAW_STYLE.stroke, "stroke-width": "2" } : { ...DRAW_STYLE };
        const r = this.editor.execute({ op: "add", tag, attrs: { ...stringify(attrs), ...style } });
        if (r.ok) {
          this.setTool("select");
          this.select([r.result.id]);
        }
        return;
      }
    }
  }

  cancelGesture(): boolean {
    const g = this.gesture;
    if (!g) return false;
    this.gesture = null;
    this.guides = null;
    if (g.kind === "marquee") g.rect.remove();
    else if (g.kind === "draw") g.el.remove();
    else if (g.kind === "pan") return true;
    else if (g.kind === "node") restoreD(g.el, g.original);
    else for (const it of g.items) restore(it);
    this.drawOverlay();
    return true;
  }

  // ---------------------------------------------------------------- text

  private openTextInput(p: Point): void {
    const at = this.toRoot(p);
    const input = document.createElement("input");
    input.className = "text-input";
    input.placeholder = "Type, then Enter";
    const hostBox = this.host.parentElement!.getBoundingClientRect();
    input.style.left = `${p.x - hostBox.left}px`;
    input.style.top = `${p.y - hostBox.top - 14}px`;
    input.dataset.x = String(round(at.x));
    input.dataset.y = String(round(at.y));
    this.host.parentElement!.appendChild(input);
    this.textInput = input;
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") this.commitText();
      if (e.key === "Escape") this.closeText();
    });
    input.addEventListener("blur", () => this.commitText());
    setTimeout(() => input.focus(), 0);
  }

  private commitText(): void {
    const input = this.textInput;
    if (!input) return;
    const text = input.value;
    this.closeText();
    if (text.trim() === "") return;
    // add + setText in one undo step.
    try {
      const id = this.editor.doc.addText(text, { x: input.dataset.x!, y: input.dataset.y!, "font-family": "sans-serif", "font-size": "16" });
      this.setTool("select");
      this.select([id]);
    } catch (e) {
      console.warn("text tool failed", e);
    }
  }

  private closeText(): void {
    const input = this.textInput;
    this.textInput = null;
    input?.remove();
  }

  // ------------------------------------------------------------ keyboard

  private keyDown(e: KeyboardEvent): void {
    if (e.key === " ") {
      this.spaceDown = true;
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      if (this.cancelGesture()) return;
      if (this.nodeEdit !== null) this.exitNodeEdit();
      else this.select([]);
      return;
    }
    if (e.key === "Enter" && this.nodeEdit === null && this.selection.length === 1) {
      if (this.editNodes(this.selection[0]!)) e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (this.nodeEdit !== null) {
        this.nodeAction("delete"); // the selected point, never the whole path
        return;
      }
      this.deleteSelection();
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = arrows[e.key];
    if (d && this.selection.length > 0) {
      e.preventDefault();
      this.nudge(d[0], d[1]);
      return;
    }
    const tools: Record<string, Tool> = { v: "select", r: "rect", e: "ellipse", l: "line", t: "text" };
    const tool = tools[e.key.toLowerCase()];
    if (tool) this.setTool(tool);
  }
}

/** Scale factors with 4 decimals, never 0. */
function roundScale(s: number): number {
  const r = Math.round(s * 1e4) / 1e4;
  return r === 0 ? Math.sign(s) * 1e-4 : r;
}

function isLayer(attrs: Record<string, string>): boolean {
  return attrs["inkscape:groupmode"] === "layer";
}

function join(a: string | null | undefined, b: string | null | undefined): string {
  return [a, b].filter((s) => s && s.trim() !== "").join(" ");
}

function restoreD(el: Element, d: string | null): void {
  if (d === null) el.removeAttribute("d");
  else el.setAttribute("d", d);
}

function restore(it: Item): void {
  if (it.original === null) it.el.removeAttribute("transform");
  else it.el.setAttribute("transform", it.original);
}

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  setAttrs(el, attrs);
  return el;
}

function setAttrs(el: Element, attrs: Record<string, string | number>): void {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
}

function stringify(attrs: Record<string, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(v)]));
}

/** Geometry attributes for a shape drawn from `a` to `b` in root user space. */
function drawAttrs(tool: "rect" | "ellipse" | "line", a: Point, b: Point, constrain: boolean): Record<string, number> {
  if (tool === "line") {
    let end = b;
    if (constrain) {
      const ang = snap(Math.atan2(b.y - a.y, b.x - a.x), Math.PI / 4);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      end = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
    }
    return { x1: round(a.x), y1: round(a.y), x2: round(end.x), y2: round(end.y) };
  }
  const r = rectFromPoints(a, b, constrain);
  if (tool === "rect") return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
  return { cx: round(r.x + r.width / 2), cy: round(r.y + r.height / 2), rx: round(r.width / 2), ry: round(r.height / 2) };
}

/** Whether the point at the end of segment `seg` has its two handles in line. */
function isSmooth(segs: PathSegment[], seg: number): boolean {
  const s = segs[seg];
  if (s?.cmd === "C") return oppositeHandle(segs, seg, "c2") !== null;
  const next = segs[seg + 1];
  return next?.cmd === "C" ? oppositeHandle(segs, seg + 1, "c1") !== null : false;
}
