export type NodeId = string;

/** Tag used for character data nodes. Their content lives in `text`. */
export const TEXT_TAG = "#text";

export interface SvgNode {
  id: NodeId;
  /** Element name ("rect", "g", ...) or TEXT_TAG for character data. */
  tag: string;
  /** Raw attribute strings; insertion order is document order. */
  attrs: Record<string, string>;
  children: NodeId[];
  parent: NodeId | null;
  /** Character data, only present on TEXT_TAG nodes. */
  text?: string;
  // Source offsets live in the parser's source map, not here: history
  // snapshots would otherwise restore stale offsets on undo.
}

export interface DocumentState {
  root: NodeId;
  nodes: Map<NodeId, SvgNode>;
  version: number;
}

export type Vec2 = [number, number];

export type Command =
  | { op: "add"; parent?: NodeId; index?: number; tag: string; attrs: Record<string, string> }
  | { op: "set"; id: NodeId; attrs: Record<string, string | null> }
  | { op: "delete"; ids: NodeId[] }
  | { op: "move"; id: NodeId; parent: NodeId; index: number }
  | { op: "group"; ids: NodeId[] }
  | { op: "ungroup"; id: NodeId }
  | {
      op: "transform";
      id: NodeId;
      translate?: Vec2;
      scale?: Vec2;
      rotate?: number;
      origin?: "center" | Vec2;
    }
  | { op: "setText"; id: NodeId; text: string }
  | { op: "batch"; commands: Command[] };

export type CommandOp = Command["op"];

export type ErrorCode =
  | "INVALID_COMMAND"
  | "UNKNOWN_OP"
  | "NOT_FOUND"
  | "INVALID_TAG"
  | "INVALID_ATTR"
  | "ROOT_NOT_ALLOWED"
  | "NOT_AN_ELEMENT"
  | "INDEX_OUT_OF_RANGE"
  | "CYCLE"
  | "DIFFERENT_PARENTS"
  | "NOT_A_GROUP"
  | "UNGROUP_LOSSY"
  | "EMPTY_TRANSFORM"
  | "INVALID_TRANSFORM"
  | "BBOX_UNAVAILABLE"
  | "HAS_ELEMENT_CHILDREN"
  | "BATCH_FAILED";

export interface CommandError {
  code: ErrorCode;
  message: string;
  hint: string;
  /** For BATCH_FAILED: path of indices to the failing sub-command, and its error. */
  path?: number[];
  cause?: CommandError;
}

/** What each op returns on success. */
export interface CommandResultMap {
  add: { id: NodeId };
  set: { id: NodeId };
  delete: { ids: NodeId[] };
  move: { id: NodeId };
  group: { id: NodeId };
  ungroup: { ids: NodeId[] };
  transform: { id: NodeId; transform: string };
  setText: { id: NodeId };
  batch: { results: unknown[] };
}

export type CommandResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: CommandError };

/** Plain-data copy of a node. Safe to hand out; mutating it does not touch the document. */
export interface NodeData {
  id: NodeId;
  tag: string;
  attrs: Record<string, string>;
  children: NodeId[];
  parent: NodeId | null;
  text?: string;
}

export interface TreeNode {
  id: NodeId;
  tag: string;
  attrs: Record<string, string>;
  text?: string;
  children: TreeNode[];
}

/** Input for SvgDocument.fromTree. Nodes without an id get a fresh one. */
export interface InputTree {
  id?: NodeId | undefined;
  tag: string;
  attrs: Record<string, string>;
  text?: string;
  children: InputTree[];
}

export interface Query {
  /** Match element name (or TEXT_TAG). Text nodes are only returned when asked for by tag. */
  tag?: string;
  /** Each entry must match; `true` means "attribute is present with any value". */
  attr?: Record<string, string | true>;
  /** Restrict to descendants of this node. Defaults to the root. */
  within?: NodeId;
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
