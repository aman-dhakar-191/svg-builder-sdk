import { runCommand, type CommandContext } from "./commands.js";
import { CommandFailure } from "./errors.js";
import {
  bboxOfPoints,
  parseLength,
  parsePoints,
  parseTransform,
  transformBBox,
  unionBBox,
} from "./geometry.js";
import { applyMutation, type Mutation } from "./mutations.js";
import { serialize, type SerializeOptions } from "./serialize.js";
import {
  TEXT_TAG,
  type BBox,
  type Command,
  type CommandError,
  type CommandResult,
  type CommandResultMap,
  type InputTree,
  type NodeData,
  type NodeId,
  type Query,
  type SvgNode,
  type TreeNode,
} from "./types.js";

interface Step {
  forward: Mutation;
  inverse: Mutation;
}

/** One undo step: everything a command or an outermost transaction changed. */
interface HistoryEntry {
  steps: Step[];
}

export interface Transaction {
  /** Keep the changes. The outermost commit becomes a single undo step. */
  commit(): void;
  /** Undo everything done since this transaction began. Nothing reaches history. */
  rollback(): void;
}

export interface CreateDocumentOptions {
  /** Attributes for the root <svg>. Defaults to the SVG namespace only. Ignored with `tree`. */
  rootAttrs?: Record<string, string>;
  /**
   * Initial content, e.g. from the parser. Nodes keep their `id` if given
   * (IDs must be unique); others get fresh IDs that never collide with them.
   */
  tree?: InputTree;
}

/** Called after each low-level change, including those from undo, redo and rollback. */
export type MutationListener = (mutation: Mutation) => void;

/**
 * History boundaries. `entry` is an opaque token identifying one undo step,
 * the same object for its commit, undo and redo. "discard" means an outermost
 * transaction closed without adding history (rollback, failed or no-op command).
 */
export type HistoryEvent =
  | { kind: "commit" | "undo" | "redo"; entry: object }
  | { kind: "discard" };

type BBoxResult = { ok: true; bbox: BBox } | { ok: false; reason: string };

export class SvgDocument {
  readonly root: NodeId;
  private readonly nodes = new Map<NodeId, SvgNode>();
  private nextId = 1;
  private _version = 0;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  /** Steps recorded since the outermost open transaction began. */
  private pending: Step[] = [];
  /** Open transactions, innermost last; each holds its start offset into `pending`. */
  private openTx: { start: number; token: object }[] = [];
  private readonly listeners = new Set<MutationListener>();
  private readonly historyListeners = new Set<(e: HistoryEvent) => void>();

  constructor(options: CreateDocumentOptions = {}) {
    const tree: InputTree = options.tree ?? {
      tag: "svg",
      attrs: options.rootAttrs ?? { xmlns: "http://www.w3.org/2000/svg" },
      children: [],
    };
    const given = new Set<NodeId>();
    const collect = (t: InputTree) => {
      if (t.id !== undefined) {
        if (given.has(t.id)) throw new Error(`Duplicate node id "${t.id}" in initial tree.`);
        given.add(t.id);
        const n = /^n_(\d+)$/.exec(t.id);
        if (n) this.nextId = Math.max(this.nextId, Number(n[1]) + 1);
      }
      t.children.forEach(collect);
    };
    collect(tree);
    const build = (t: InputTree, parent: NodeId | null): NodeId => {
      const id = t.id ?? this.newId();
      const node: SvgNode = { id, tag: t.tag, attrs: { ...t.attrs }, children: [], parent };
      if (t.text !== undefined) node.text = t.text;
      this.nodes.set(id, node);
      node.children = t.children.map((c) => build(c, id));
      return id;
    };
    this.root = build(tree, null);
    this.context = {
      root: this.root,
      get: (id) => this.nodes.get(id),
      apply: (m) => {
        const inverse = this.mutate(m);
        this.pending.push({ forward: m, inverse });
      },
      newId: () => this.newId(),
      bbox: (id) => this.computeBBox(id),
    };
  }

  /**
   * Subscribes to low-level changes as they are applied. The parser package
   * uses this to turn every change into a minimal text patch. Listeners must
   * not execute commands. Returns an unsubscribe function.
   */
  onMutation(listener: MutationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribes to history boundaries (see HistoryEvent). Returns an unsubscribe function. */
  onHistory(listener: (e: HistoryEvent) => void): () => void {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }

  /** Increments on every change, including undo, redo and rollback. */
  get version(): number {
    return this._version;
  }

  // ------------------------------------------------------------------ write

  execute<C extends Command>(cmd: C): CommandResult<CommandResultMap[C["op"]]>;
  execute(cmd: unknown): CommandResult;
  execute(cmd: unknown): CommandResult {
    const tx = this.beginTransaction();
    try {
      const result = runCommand(this.context, cmd);
      tx.commit();
      return { ok: true, result };
    } catch (e) {
      tx.rollback();
      if (e instanceof CommandFailure) return { ok: false, error: e.error };
      throw e;
    }
  }

  /**
   * Opens a transaction. Commands executed until it closes form one undo step.
   * Transactions nest; they must be closed innermost first. Async-safe: the
   * caller decides when to commit, so it can span awaits.
   */
  beginTransaction(): Transaction {
    const token = {};
    this.openTx.push({ start: this.pending.length, token });
    const close = (keep: boolean) => {
      const top = this.openTx[this.openTx.length - 1];
      if (!top || top.token !== token) {
        throw new Error(
          this.openTx.some((t) => t.token === token)
            ? "Transactions must be closed innermost first."
            : "Transaction is already closed.",
        );
      }
      this.openTx.pop();
      if (!keep) {
        const undone = this.pending.splice(top.start);
        for (let i = undone.length - 1; i >= 0; i--) this.mutate(undone[i]!.inverse);
      }
      if (this.openTx.length === 0) {
        const steps = this.pending;
        this.pending = [];
        if (steps.length > 0) {
          const entry = { steps };
          this.undoStack.push(entry);
          this.redoStack = [];
          this.emitHistory({ kind: "commit", entry });
        } else {
          this.emitHistory({ kind: "discard" });
        }
      }
    };
    return { commit: () => close(true), rollback: () => close(false) };
  }

  /**
   * Runs `fn` as one undo step. If it throws, everything it did is rolled back
   * and the error is rethrown. For async work use beginTransaction().
   */
  transaction<T>(fn: () => T): T {
    const tx = this.beginTransaction();
    let result: T;
    try {
      result = fn();
    } catch (e) {
      tx.rollback();
      throw e;
    }
    if (result instanceof Promise) {
      tx.rollback();
      throw new TypeError("transaction() callback returned a Promise; use beginTransaction() for async work.");
    }
    tx.commit();
    return result;
  }

  get inTransaction(): boolean {
    return this.openTx.length > 0;
  }

  // ---------------------------------------------------------------- history

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    this.assertNoTransaction("undo");
    const entry = this.undoStack.pop();
    if (!entry) return false;
    for (let i = entry.steps.length - 1; i >= 0; i--) this.mutate(entry.steps[i]!.inverse);
    this.redoStack.push(entry);
    this.emitHistory({ kind: "undo", entry });
    return true;
  }

  redo(): boolean {
    this.assertNoTransaction("redo");
    const entry = this.redoStack.pop();
    if (!entry) return false;
    for (const step of entry.steps) this.mutate(step.forward);
    this.undoStack.push(entry);
    this.emitHistory({ kind: "redo", entry });
    return true;
  }

  // ------------------------------------------------------------------- read

  getNode(id: NodeId): NodeData | undefined {
    const n = this.nodes.get(id);
    if (!n) return undefined;
    const data: NodeData = { id: n.id, tag: n.tag, attrs: { ...n.attrs }, children: [...n.children], parent: n.parent };
    if (n.text !== undefined) data.text = n.text;
    return data;
  }

  getTree(id: NodeId = this.root): TreeNode | undefined {
    const n = this.nodes.get(id);
    if (!n) return undefined;
    const tree: TreeNode = { id: n.id, tag: n.tag, attrs: { ...n.attrs }, children: n.children.map((c) => this.getTree(c)!) };
    if (n.text !== undefined) tree.text = n.text;
    return tree;
  }

  /**
   * Node IDs matching every given criterion, in document order. Without
   * `within`, the whole document (root included) is searched; with it, only
   * that node's descendants.
   */
  query(q: Query = {}): NodeId[] {
    const out: NodeId[] = [];
    const start = q.within ?? this.root;
    const startNode = this.nodes.get(start);
    if (!startNode) return out;
    const matches = (n: SvgNode) => {
      if (q.tag !== undefined ? n.tag !== q.tag : n.tag === TEXT_TAG) return false;
      for (const [k, v] of Object.entries(q.attr ?? {})) {
        if (!(k in n.attrs) || (v !== true && n.attrs[k] !== v)) return false;
      }
      return true;
    };
    const walk = (id: NodeId, self: boolean) => {
      const n = this.nodes.get(id)!;
      if (self && matches(n)) out.push(id);
      n.children.forEach((c) => walk(c, true));
    };
    walk(start, q.within === undefined);
    return out;
  }

  /**
   * Bounding box in the node's own user space (its own transform excluded),
   * like DOM getBBox(). Computed from attributes, so it covers rect, circle,
   * ellipse, line, polyline, polygon, image, foreignObject and groups of those.
   * Paths and text need a renderer or path library (later steps).
   */
  getBBox(id: NodeId): CommandResult<BBox> {
    if (!this.nodes.has(id)) {
      return { ok: false, error: { code: "NOT_FOUND", message: `No node with id "${id}".`, hint: "Call getTree() or query() to list current node IDs." } };
    }
    const r = this.computeBBox(id);
    if (r.ok) return { ok: true, result: r.bbox };
    const error: CommandError = { code: "BBOX_UNAVAILABLE", message: r.reason, hint: "Headless bboxes cover basic shapes and groups of them; paths and text need the renderer." };
    return { ok: false, error };
  }

  toSvg(options: SerializeOptions = {}): string {
    return serialize((id) => this.nodes.get(id)!, this.root, options);
  }

  // --------------------------------------------------------------- internal

  private readonly context: CommandContext;

  private newId(): NodeId {
    return `n_${this.nextId++}`;
  }

  private mutate(m: Mutation): Mutation {
    const inverse = applyMutation(this.nodes, m);
    this._version++;
    for (const listener of this.listeners) listener(m);
    return inverse;
  }

  private emitHistory(e: HistoryEvent): void {
    for (const l of this.historyListeners) l(e);
  }

  private assertNoTransaction(action: string): void {
    if (this.inTransaction) throw new Error(`Cannot ${action} while a transaction is open.`);
  }

  private computeBBox(id: NodeId): BBoxResult {
    const n = this.nodes.get(id)!;
    const a = n.attrs;
    const len = (name: string, fallback: number | null = 0) => parseLength(a[name], fallback);
    const unsupported = (why: string): BBoxResult => ({ ok: false, reason: `<${n.tag}> "${id}": ${why}` });
    const box = (x: number | null, y: number | null, w: number | null, h: number | null): BBoxResult =>
      x === null || y === null || w === null || h === null
        ? unsupported("uses percentages or units the headless model cannot resolve.")
        : { ok: true, bbox: { x, y, width: w, height: h } };

    switch (n.tag) {
      case "rect":
      case "image":
      case "foreignObject":
        return box(len("x"), len("y"), len("width"), len("height"));
      case "circle": {
        const [cx, cy, r] = [len("cx"), len("cy"), len("r")];
        return r === null ? box(null, null, null, null) : box(cx === null ? null : cx - r, cy === null ? null : cy - r, 2 * r, 2 * r);
      }
      case "ellipse": {
        const ry0 = len("ry", null);
        const rx = len("rx", ry0 ?? 0);
        const ry = ry0 ?? rx;
        const [cx, cy] = [len("cx"), len("cy")];
        if (rx === null || ry === null || cx === null || cy === null) return box(null, null, null, null);
        return box(cx - rx, cy - ry, 2 * rx, 2 * ry);
      }
      case "line": {
        const pts = [len("x1"), len("y1"), len("x2"), len("y2")];
        if (pts.some((p) => p === null)) return box(null, null, null, null);
        const [x1, y1, x2, y2] = pts as number[];
        return { ok: true, bbox: bboxOfPoints([[x1!, y1!], [x2!, y2!]])! };
      }
      case "polyline":
      case "polygon": {
        const pts = parsePoints(a.points);
        if (pts === null) return unsupported('has an odd number of coordinates in "points".');
        const b = bboxOfPoints(pts);
        return b ? { ok: true, bbox: b } : unsupported("has no points.");
      }
      case "g": {
        const boxes: BBox[] = [];
        for (const c of n.children) {
          const child = this.nodes.get(c)!;
          if (child.tag === TEXT_TAG) continue;
          const r = this.computeBBox(c);
          if (!r.ok) return r;
          const m = parseTransform(child.attrs.transform);
          if (!m) return { ok: false, reason: `<${child.tag}> "${c}": transform could not be parsed.` };
          boxes.push(transformBBox(m, r.bbox));
        }
        const u = unionBBox(boxes);
        return u ? { ok: true, bbox: u } : unsupported("is empty.");
      }
      default:
        return unsupported("no headless geometry for this element.");
    }
  }
}

export function createDocument(options?: CreateDocumentOptions): SvgDocument {
  return new SvgDocument(options);
}
