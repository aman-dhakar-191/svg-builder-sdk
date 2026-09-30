import { CommandFailure, fail } from "./errors.js";
import {
  applyToPoint,
  formatNumber,
  parseTransform,
  parseTransformList,
} from "./geometry.js";
import type { Mutation } from "./mutations.js";
import {
  TEXT_TAG,
  type BBox,
  type CommandError,
  type CommandResultMap,
  type InputTree,
  type NodeId,
  type SvgNode,
  type Vec2,
} from "./types.js";

/** What command handlers may touch. Every change goes through `apply`. */
export interface CommandContext {
  readonly root: NodeId;
  get(id: NodeId): SvgNode | undefined;
  apply(m: Mutation): void;
  newId(): NodeId;
  bbox(id: NodeId): { ok: true; bbox: BBox } | { ok: false; reason: string };
}

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;

/**
 * Inherited presentation attributes. Ungroup copies these from the group onto
 * children that do not set them, which keeps rendering identical.
 */
const INHERITED_ATTRS = new Set([
  "clip-rule", "color", "color-interpolation", "color-interpolation-filters",
  "color-rendering", "cursor", "direction", "dominant-baseline", "fill",
  "fill-opacity", "fill-rule", "font", "font-family", "font-size",
  "font-size-adjust", "font-stretch", "font-style", "font-variant", "font-weight",
  "image-rendering", "letter-spacing", "marker", "marker-end", "marker-mid",
  "marker-start", "paint-order", "pointer-events", "shape-rendering", "stroke",
  "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-opacity", "stroke-width", "text-anchor",
  "text-rendering", "visibility", "word-spacing", "writing-mode",
]);

// ---------------------------------------------------------------- validation

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, field: string, op: string): string {
  if (typeof v !== "string" || v === "") {
    fail("INVALID_COMMAND", `${op}: "${field}" must be a non-empty string.`, `Pass a node ID such as "n_3".`);
  }
  return v;
}

function requireIdList(v: unknown, field: string, op: string): NodeId[] {
  if (!Array.isArray(v) || v.length === 0) {
    fail("INVALID_COMMAND", `${op}: "${field}" must be a non-empty array of node IDs.`, `Example: { op: "${op}", ${field}: ["n_2", "n_3"] }.`);
  }
  const ids = v.map((id, i) => requireString(id, `${field}[${i}]`, op));
  return [...new Set(ids)];
}

function requireIndex(v: unknown, op: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    fail("INVALID_COMMAND", `${op}: "index" must be an integer, got ${JSON.stringify(v)}.`, "Use 0 for first position; omit it (add only) to append.");
  }
  return v;
}

function requireVec2(v: unknown, field: string): Vec2 {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    fail("INVALID_COMMAND", `transform: "${field}" must be [x, y] with two finite numbers, got ${JSON.stringify(v)}.`, `Example: ${field}: [10, 20].`);
  }
  return [v[0], v[1]];
}

function requireName(name: string, kind: "tag" | "attribute"): void {
  if (!NAME.test(name)) {
    fail(
      kind === "tag" ? "INVALID_TAG" : "INVALID_ATTR",
      `"${name}" is not a valid XML ${kind} name.`,
      kind === "tag"
        ? 'Use an SVG element name such as "rect", "g" or "path". Use setText for text content.'
        : 'Attribute names look like "fill", "stroke-width" or "xlink:href".',
    );
  }
}

function getNode(ctx: CommandContext, id: NodeId): SvgNode {
  const node = ctx.get(id);
  if (!node) fail("NOT_FOUND", `No node with id "${id}".`, "Call getTree() or query() to list current node IDs; IDs of deleted nodes are not reused.");
  return node;
}

function getElement(ctx: CommandContext, id: NodeId, op: string): SvgNode {
  const node = getNode(ctx, id);
  if (node.tag === TEXT_TAG) {
    fail("NOT_AN_ELEMENT", `${op}: "${id}" is a text node, not an element.`, `Target its parent element "${node.parent}" instead.`);
  }
  return node;
}

function notRoot(ctx: CommandContext, id: NodeId, op: string): void {
  if (id === ctx.root) {
    fail("ROOT_NOT_ALLOWED", `${op}: the root <svg> element cannot be ${op === "delete" ? "deleted" : `the target of ${op}`}.`, "Target its children instead.");
  }
}

function indexOf(ctx: CommandContext, id: NodeId): number {
  const node = ctx.get(id)!;
  return ctx.get(node.parent!)!.children.indexOf(id);
}

function isAncestor(ctx: CommandContext, ancestor: NodeId, id: NodeId): boolean {
  for (let cur = ctx.get(id)?.parent ?? null; cur !== null; cur = ctx.get(cur)?.parent ?? null) {
    if (cur === ancestor) return true;
  }
  return false;
}

function sameAttrs(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

const isText = (ctx: CommandContext, id: NodeId | undefined): boolean =>
  id !== undefined && ctx.get(id)?.tag === TEXT_TAG;

/**
 * Text nodes are never adjacent (output would merge them) and never empty
 * (they would vanish), and this holds after every single mutation, not just
 * after each command, because the text patcher checks every step. So text on
 * both sides of a node is merged *before* the node is taken out.
 * Returns the merge made, if any.
 */
function detach(ctx: CommandContext, id: NodeId): { removed: NodeId; into: NodeId } | null {
  const siblings = ctx.get(ctx.get(id)!.parent!)!.children;
  const i = siblings.indexOf(id);
  const prev = siblings[i - 1];
  const next = siblings[i + 1];
  if (!isText(ctx, prev) || !isText(ctx, next)) return null;
  ctx.apply({ kind: "text", id: prev!, text: ctx.get(prev!)!.text! + ctx.get(next!)!.text! });
  ctx.apply({ kind: "remove", id: next! });
  return { removed: next!, into: prev! };
}

function removeNode(ctx: CommandContext, id: NodeId): void {
  detach(ctx, id);
  ctx.apply({ kind: "remove", id });
}

/** Moves `id` to final position `index` under `parentId`, keeping text normalized. */
function moveNode(ctx: CommandContext, id: NodeId, parentId: NodeId, index: number): void {
  const post = ctx.get(parentId)!.children.filter((c) => c !== id);
  let anchor = index > 0 ? post[index - 1] : undefined;
  const node = ctx.get(id)!;
  if (node.tag === TEXT_TAG) {
    // Text landing next to text joins it instead.
    const next = post[index];
    if (isText(ctx, anchor) || isText(ctx, next)) {
      const target = isText(ctx, anchor) ? anchor! : next!;
      const t = ctx.get(target)!.text!;
      ctx.apply({ kind: "text", id: target, text: target === anchor ? t + node.text : node.text + t });
      removeNode(ctx, id);
      return;
    }
  }
  const merged = detach(ctx, id);
  if (merged && anchor === merged.removed) anchor = merged.into;
  const rest = ctx.get(parentId)!.children.filter((c) => c !== id);
  const at = anchor === undefined ? 0 : rest.indexOf(anchor) + 1;
  if (node.parent !== parentId || ctx.get(parentId)!.children.indexOf(id) !== at) {
    ctx.apply({ kind: "move", id, parent: parentId, index: at });
  }
}

function setAttrs(ctx: CommandContext, node: SvgNode, attrs: Record<string, string>): void {
  if (!sameAttrs(node.attrs, attrs)) ctx.apply({ kind: "attrs", id: node.id, attrs });
}

// ------------------------------------------------------------------ handlers

function add(ctx: CommandContext, cmd: Record<string, unknown>): CommandResultMap["add"] {
  if (typeof cmd.tag !== "string") fail("INVALID_COMMAND", 'add: "tag" must be a string.', 'Example: { op: "add", tag: "rect", attrs: { width: "10" } }.');
  requireName(cmd.tag, "tag");
  const attrs = cmd.attrs ?? {};
  if (!isRecord(attrs)) fail("INVALID_COMMAND", 'add: "attrs" must be an object of string values.', 'Example: attrs: { x: "10", fill: "red" }.');
  for (const [k, v] of Object.entries(attrs)) {
    requireName(k, "attribute");
    if (typeof v !== "string") fail("INVALID_ATTR", `add: attribute "${k}" must be a string, got ${typeof v}.`, `Write numbers as strings, e.g. ${k}: "${String(v)}".`);
  }
  const parentId = cmd.parent === undefined ? ctx.root : requireString(cmd.parent, "parent", "add");
  const parent = getElement(ctx, parentId, "add");
  const index = cmd.index === undefined ? parent.children.length : requireIndex(cmd.index, "add");
  if (index < 0 || index > parent.children.length) {
    fail("INDEX_OUT_OF_RANGE", `add: index ${index} is outside 0..${parent.children.length} for parent "${parent.id}".`, "Omit index to append as the last child.");
  }
  const id = ctx.newId();
  ctx.apply({
    kind: "insert",
    parent: parent.id,
    index,
    nodes: [{ id, tag: cmd.tag, attrs: { ...(attrs as Record<string, string>) }, children: [], parent: parent.id }],
  });
  return { id };
}

function set(ctx: CommandContext, cmd: Record<string, unknown>): CommandResultMap["set"] {
  const node = getElement(ctx, requireString(cmd.id, "id", "set"), "set");
  if (!isRecord(cmd.attrs)) fail("INVALID_COMMAND", 'set: "attrs" must be an object.', 'Use a string to set and null to remove, e.g. attrs: { fill: "red", stroke: null }.');
  const next = { ...node.attrs };
  for (const [k, v] of Object.entries(cmd.attrs)) {
    requireName(k, "attribute");
    if (v === null) delete next[k];
    else if (typeof v === "string") next[k] = v;
    else fail("INVALID_ATTR", `set: attribute "${k}" must be a string or null, got ${typeof v}.`, `Write numbers as strings, e.g. ${k}: "${String(v)}".`);
  }
  setAttrs(ctx, node, next);
  return { id: node.id };
}

function del(ctx: CommandContext, cmd: Record<string, unknown>): CommandResultMap["delete"] {
  const ids = requireIdList(cmd.ids, "ids", "delete");
  for (const id of ids) {
    getNode(ctx, id);
    notRoot(ctx, id, "delete");
  }
  // Deleting an ancestor already removes its descendants.
  const top = ids.filter((id) => !ids.some((other) => other !== id && isAncestor(ctx, other, id)));
  for (const id of top) if (ctx.get(id)) removeNode(ctx, id);
  return { ids: top };
}

function move(ctx: CommandContext, cmd: Record<string, unknown>): CommandResultMap["move"] {
  const id = requireString(cmd.id, "id", "move");
  const node = getNode(ctx, id);
  notRoot(ctx, id, "move");
  const parent = getElement(ctx, requireString(cmd.parent, "parent", "move"), "move");
  if (parent.id === id || isAncestor(ctx, id, parent.id)) {
    fail("CYCLE", `move: cannot move "${id}" into itself or its own descendant "${parent.id}".`, "Pick a parent outside the node's subtree.");
  }
  const index = requireIndex(cmd.index, "move");
  const max = node.parent === parent.id ? parent.children.length - 1 : parent.children.length;
  if (index < 0 || index > max) {
    fail("INDEX_OUT_OF_RANGE", `move: index ${index} is outside 0..${max} for parent "${parent.id}".`, "The index is the node's final position among the parent's children.");
  }
  if (node.parent !== parent.id || indexOf(ctx, id) !== index) moveNode(ctx, id, parent.id, index);
  return { id };
}

function group(ctx: CommandContext, cmd: Record<string, unknown>): CommandResultMap["group"] {
  const ids = requireIdList(cmd.ids, "ids", "group");
  for (const id of ids) {
    getElement(ctx, id, "group");
    notRoot(ctx, id, "group");
  }
  const parentId = ctx.get(ids[0]!)!.parent!;
  const stray = ids.find((id) => ctx.get(id)!.parent !== parentId);
  if (stray) {
    fail("DIFFERENT_PARENTS", `group: "${stray}" has a different parent than "${ids[0]}".`, "All nodes in a group command must be siblings; move them under one parent first.");
  }
  const ordered = [...ids].sort((a, b) => indexOf(ctx, a) - indexOf(ctx, b));
  const gid = ctx.newId();
  ctx.apply({
    kind: "insert",
    parent: parentId,
    index: indexOf(ctx, ordered[0]!),
    nodes: [{ id: gid, tag: "g", attrs: {}, children: [], parent: parentId }],
  });
  ordered.forEach((id, i) => moveNode(ctx, id, gid, i));
  return { id: gid };
}

function ungroup(ctx: CommandContext, cmd: Record<string, unknown>): CommandResultMap["ungroup"] {
  const id = requireString(cmd.id, "id", "ungroup");
  const g = getElement(ctx, id, "ungroup");
  notRoot(ctx, id, "ungroup");
  if (g.tag !== "g") fail("NOT_A_GROUP", `ungroup: "${id}" is a <${g.tag}>, not a <g>.`, "Only <g> elements can be ungrouped.");
  const lossy = Object.keys(g.attrs).filter((k) => k !== "id" && k !== "transform" && !INHERITED_ATTRS.has(k));
  if (lossy.length > 0) {
    fail(
      "UNGROUP_LOSSY",
      `ungroup: the group's ${lossy.map((k) => `"${k}"`).join(", ")} cannot be moved onto its children without changing how it renders.`,
      `Remove ${lossy.length === 1 ? "that attribute" : "those attributes"} with set (value null) first if the change is acceptable.`,
    );
  }
  const groupTransform = g.attrs.transform;
  const children = [...g.children];
  const parentId = g.parent!;
  const start = indexOf(ctx, id);
  let at = start + 1;
  for (const child of children) {
    moveNode(ctx, child, parentId, at);
    if (ctx.get(child)?.parent === parentId) at = indexOf(ctx, child) + 1;
  }
  removeNode(ctx, id);
  for (const childId of children) {
    if (!ctx.get(childId)) continue; // merged into a neighbouring text node
    const child = ctx.get(childId)!;
    if (child.tag === TEXT_TAG) continue;
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(g.attrs)) {
      if (INHERITED_ATTRS.has(k) && !(k in child.attrs)) next[k] = v;
    }
    Object.assign(next, child.attrs);
    if (groupTransform !== undefined && groupTransform.trim() !== "") {
      const own = child.attrs.transform?.trim();
      next.transform = own ? `${groupTransform.trim()} ${own}` : groupTransform.trim();
    }
    setAttrs(ctx, child, next);
  }
  return { ids: children.filter((c) => ctx.get(c) !== undefined) };
}

function transform(ctx: CommandContext, cmd: Record<string, unknown>): CommandResultMap["transform"] {
  const id = requireString(cmd.id, "id", "transform");
  const node = getElement(ctx, id, "transform");
  const translate = cmd.translate === undefined ? undefined : requireVec2(cmd.translate, "translate");
  const scale = cmd.scale === undefined ? undefined : requireVec2(cmd.scale, "scale");
  let rotate: number | undefined;
  if (cmd.rotate !== undefined) {
    if (typeof cmd.rotate !== "number" || !Number.isFinite(cmd.rotate)) {
      fail("INVALID_COMMAND", `transform: "rotate" must be a finite number of degrees, got ${JSON.stringify(cmd.rotate)}.`, "Example: rotate: 45 (clockwise, in degrees).");
    }
    rotate = cmd.rotate;
  }
  if (!translate && !scale && rotate === undefined) {
    fail("EMPTY_TRANSFORM", "transform: nothing to do.", "Pass at least one of translate, scale or rotate.");
  }
  if (scale && (scale[0] === 0 || scale[1] === 0)) {
    fail("INVALID_COMMAND", "transform: scale factors must be non-zero.", "A zero scale collapses the element; delete it instead, or use a small value.");
  }

  const space = cmd.space ?? "parent";
  if (space !== "parent" && space !== "local") {
    fail("INVALID_COMMAND", `transform: "space" must be "parent" or "local", got ${JSON.stringify(cmd.space)}.`, 'Use "local" to transform along the element\'s own axes.');
  }
  const existing = node.attrs.transform;
  const ops = existing === undefined ? [] : parseTransformList(existing);
  if (!ops) {
    fail("INVALID_TRANSFORM", `transform: existing transform "${existing}" on "${id}" could not be parsed.`, 'Fix or remove it first with set, e.g. attrs: { transform: null }.');
  }

  let origin: Vec2 = [0, 0];
  if (cmd.origin === "center") {
    if (scale || rotate !== undefined) {
      const box = ctx.bbox(id);
      if (!box.ok) {
        fail("BBOX_UNAVAILABLE", `transform: cannot find the center of "${id}": ${box.reason}`, "Pass an explicit origin: [x, y] in the parent's coordinates.");
      }
      const center: Vec2 = [box.bbox.x + box.bbox.width / 2, box.bbox.y + box.bbox.height / 2];
      origin = space === "local" ? center : applyToPoint(parseTransform(existing)!, center);
    }
  } else if (cmd.origin !== undefined) {
    origin = requireVec2(cmd.origin, "origin");
  }

  const f = formatNumber;
  const [ox, oy] = origin;
  const aroundOrigin = ox !== 0 || oy !== 0;
  const prefix: string[] = [];
  // Written outermost first: translate is applied last, scale first.
  if (translate) prefix.push(`translate(${f(translate[0])} ${f(translate[1])})`);
  if (rotate !== undefined) prefix.push(aroundOrigin ? `rotate(${f(rotate)} ${f(ox)} ${f(oy)})` : `rotate(${f(rotate)})`);
  if (scale) {
    const s = `scale(${f(scale[0])} ${f(scale[1])})`;
    prefix.push(aroundOrigin ? `translate(${f(ox)} ${f(oy)}) ${s} translate(${f(-ox)} ${f(-oy)})` : s);
  }

  let value: string;
  const first = ops[0];
  if (space === "local") {
    // Local ops go after the existing list: they apply first, in the element's own space.
    const rest = existing?.trim();
    value = rest ? `${rest} ${prefix.join(" ")}` : prefix.join(" ");
  } else if (translate && !scale && rotate === undefined && first?.name === "translate") {
    // Fold repeated moves into the existing leading translate instead of stacking them.
    const merged = `translate(${f(first.args[0]! + translate[0])} ${f((first.args[1] ?? 0) + translate[1])})`;
    value = merged + existing!.slice(first.end);
  } else {
    const rest = existing?.trim();
    value = rest ? `${prefix.join(" ")} ${rest}` : prefix.join(" ");
  }
  setAttrs(ctx, node, { ...node.attrs, transform: value });
  return { id, transform: value };
}

function setText(ctx: CommandContext, cmd: Record<string, unknown>): CommandResultMap["setText"] {
  const id = requireString(cmd.id, "id", "setText");
  const node = getNode(ctx, id);
  if (typeof cmd.text !== "string") fail("INVALID_COMMAND", 'setText: "text" must be a string.', 'Example: { op: "setText", id: "n_4", text: "Hello" }.');
  const text = cmd.text;
  if (node.tag === TEXT_TAG) {
    if (text === "") removeNode(ctx, id);
    else if (node.text !== text) ctx.apply({ kind: "text", id, text });
    return { id };
  }
  const elementChild = node.children.find((c) => ctx.get(c)!.tag !== TEXT_TAG);
  if (elementChild) {
    fail(
      "HAS_ELEMENT_CHILDREN",
      `setText: <${node.tag}> "${id}" contains element children (e.g. "${elementChild}"); replacing its text would delete them.`,
      "Call setText on a specific text node or <tspan>, or delete the child elements first.",
    );
  }
  const [firstText, ...extra] = node.children;
  for (const c of extra) ctx.apply({ kind: "remove", id: c });
  if (firstText === undefined) {
    if (text !== "") {
      ctx.apply({ kind: "insert", parent: id, index: 0, nodes: [{ id: ctx.newId(), tag: TEXT_TAG, attrs: {}, children: [], parent: id, text }] });
    }
  } else if (text === "") {
    ctx.apply({ kind: "remove", id: firstText });
  } else if (ctx.get(firstText)!.text !== text) {
    ctx.apply({ kind: "text", id: firstText, text });
  }
  return { id };
}

function batch(ctx: CommandContext, cmd: Record<string, unknown>): CommandResultMap["batch"] {
  if (!Array.isArray(cmd.commands)) {
    fail("INVALID_COMMAND", 'batch: "commands" must be an array.', 'Example: { op: "batch", commands: [{ op: "add", ... }, ...] }.');
  }
  const results: unknown[] = [];
  cmd.commands.forEach((sub: unknown, i: number) => {
    try {
      results.push(runCommand(ctx, sub));
    } catch (e) {
      if (!(e instanceof CommandFailure)) throw e;
      const inner = e.error;
      const cause: CommandError = inner.code === "BATCH_FAILED" && inner.cause ? inner.cause : inner;
      const path = [i, ...(inner.code === "BATCH_FAILED" ? (inner.path ?? []) : [])];
      throw new CommandFailure({
        code: "BATCH_FAILED",
        message: `batch: command ${path.join(".")} failed, nothing was applied. ${cause.code}: ${cause.message}`,
        hint: cause.hint,
        path,
        cause,
      });
    }
  });
  return { results };
}

function replace(ctx: CommandContext, cmd: Record<string, unknown>): CommandResultMap["replace"] {
  const tree = cmd.tree;
  if (!isRecord(tree)) fail("INVALID_COMMAND", 'replace: "tree" must be an object.', 'Example: { op: "replace", tree: { tag: "svg", attrs: {}, children: [] } }.');
  if (tree.tag !== "svg") fail("INVALID_TAG", `replace: the root must be <svg>, got <${String(tree.tag)}>.`, "Wrap the content in an <svg> element.");
  if (tree.id !== undefined && tree.id !== ctx.root) fail("INVALID_COMMAND", `replace: root id must be "${ctx.root}" or omitted.`, "The root element keeps its ID.");

  // Validate everything before touching the document.
  const seen = new Set<NodeId>();
  const check = (t: unknown, path: string): void => {
    if (!isRecord(t) || typeof t.tag !== "string" || !isRecord(t.attrs) || !Array.isArray(t.children)) {
      fail("INVALID_COMMAND", `replace: node at ${path} needs tag, attrs and children.`, "Use the shape { tag, attrs, children, text?, id? }.");
    }
    if (t.tag === TEXT_TAG) {
      if (typeof t.text !== "string" || t.text === "" || t.children.length > 0 || Object.keys(t.attrs).length > 0) {
        fail("INVALID_COMMAND", `replace: text node at ${path} needs non-empty text and no attrs or children.`, 'Example: { tag: "#text", attrs: {}, text: "Hi", children: [] }.');
      }
    } else {
      requireName(t.tag, "tag");
      for (const [k, v] of Object.entries(t.attrs)) {
        requireName(k, "attribute");
        if (typeof v !== "string") fail("INVALID_ATTR", `replace: attribute "${k}" at ${path} must be a string.`, `Write numbers as strings, e.g. ${k}: "${String(v)}".`);
      }
    }
    if (t.id !== undefined && path !== "root") {
      if (typeof t.id !== "string" || !ctx.get(t.id) || t.id === ctx.root) {
        fail("NOT_FOUND", `replace: id ${JSON.stringify(t.id)} at ${path} is not a node of this document.`, "Only reuse IDs of existing nodes; omit id for new nodes.");
      }
      if (seen.has(t.id)) fail("INVALID_COMMAND", `replace: id "${t.id}" is used twice.`, "Each ID may appear once.");
      seen.add(t.id);
    }
    t.children.forEach((c: unknown, i: number) => check(c, `${path}.${i}`));
  };
  check(tree, "root");

  const root = ctx.get(ctx.root)!;
  // Remove from the end and insert from the start: every intermediate state is
  // a prefix of a valid document, so it can always be written as text.
  for (let i = root.children.length - 1; i >= 0; i--) ctx.apply({ kind: "remove", id: root.children[i]! });
  setAttrs(ctx, root, { ...(tree.attrs as Record<string, string>) });
  const flatten = (t: InputTree, parent: NodeId, out: SvgNode[]): NodeId => {
    const id = t.id ?? ctx.newId();
    const node: SvgNode = { id, tag: t.tag, attrs: { ...t.attrs }, children: [], parent };
    if (t.text !== undefined) node.text = t.text;
    out.push(node);
    node.children = t.children.map((c) => flatten(c, id, out));
    return id;
  };
  (tree.children as InputTree[]).forEach((child, index) => {
    const nodes: SvgNode[] = [];
    flatten(child, ctx.root, nodes);
    ctx.apply({ kind: "insert", parent: ctx.root, index, nodes });
  });
  return { root: ctx.root };
}

const HANDLERS: Record<string, (ctx: CommandContext, cmd: Record<string, unknown>) => unknown> = {
  add,
  set,
  delete: del,
  move,
  group,
  ungroup,
  transform,
  setText,
  batch,
  replace,
};

/** Runs one command. Throws CommandFailure; the caller rolls back partial changes. */
export function runCommand(ctx: CommandContext, cmd: unknown): unknown {
  if (!isRecord(cmd) || typeof cmd.op !== "string") {
    fail("INVALID_COMMAND", "A command must be an object with a string \"op\".", `Valid ops: ${Object.keys(HANDLERS).join(", ")}.`);
  }
  const handler = HANDLERS[cmd.op];
  if (!handler || !Object.hasOwn(HANDLERS, cmd.op)) {
    fail("UNKNOWN_OP", `Unknown op "${cmd.op}".`, `Valid ops: ${Object.keys(HANDLERS).join(", ")}.`);
  }
  return handler(ctx, cmd);
}

