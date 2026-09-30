import { TEXT_CONTAINERS, TEXT_TAG, type InputTree, type NodeData, type NodeId } from "@svg-editor/model";
import type { ParsedElement, ParsedNode } from "./parse.js";

// Outside TEXT_CONTAINERS, whitespace-only text between elements is formatting:
// it stays in the source but not in the model.
/** Formatting whitespace: dropped from the model outside text containers. */
export function isFormatting(node: ParsedNode, inTextContext: boolean): boolean {
  return node.kind === "text" && node.whitespace && !inTextContext;
}

/** Converts a parse tree to model input (no IDs). */
export function toInputTree(el: ParsedElement, inTextContext = false): InputTree {
  const ctx = inTextContext || TEXT_CONTAINERS.has(el.tag);
  const children: InputTree[] = [];
  for (const c of el.children) {
    if (isFormatting(c, ctx)) continue;
    children.push(c.kind === "text" ? { tag: TEXT_TAG, attrs: {}, text: c.text, children: [] } : toInputTree(c, ctx));
  }
  return { tag: el.tag, attrs: Object.fromEntries(el.attrs.map((a) => [a.name, a.value])), children };
}

export interface SourceMap {
  byId: Map<NodeId, ParsedNode>;
  idOf: Map<ParsedNode, NodeId>;
  parentOf: Map<NodeId, NodeId>;
  /** IDs whose element is (inside) a text container. */
  textContext: Set<NodeId>;
}

/**
 * Walks a parse tree and the model side by side. Returns the source map if
 * they describe exactly the same document (tags, attributes in order, text),
 * or null at the first difference. After every patch this is the proof that
 * the patched text still says what the model says.
 */
export function zip(root: ParsedElement, rootId: NodeId, get: (id: NodeId) => NodeData | undefined): SourceMap | null {
  const map: SourceMap = { byId: new Map(), idOf: new Map(), parentOf: new Map(), textContext: new Set() };
  const walk = (p: ParsedNode, id: NodeId, parentCtx: boolean): boolean => {
    const n = get(id);
    if (!n) return false;
    map.byId.set(id, p);
    map.idOf.set(p, id);
    if (p.kind === "text") return n.tag === TEXT_TAG && n.text === p.text;
    if (n.tag !== p.tag) return false;
    const attrs = Object.entries(n.attrs);
    if (attrs.length !== p.attrs.length) return false;
    for (let i = 0; i < attrs.length; i++) {
      const [k, v] = attrs[i]!;
      if (p.attrs[i]!.name !== k || p.attrs[i]!.value !== v) return false;
    }
    const ctx = parentCtx || TEXT_CONTAINERS.has(p.tag);
    if (ctx) map.textContext.add(id);
    let j = 0;
    for (const c of p.children) {
      const childId = n.children[j];
      if (isFormatting(c, ctx)) {
        // Formatting whitespace is skipped unless the model really has that text.
        const m = childId === undefined ? undefined : get(childId);
        if (!(m && m.tag === TEXT_TAG && c.kind === "text" && m.text === c.text)) continue;
      }
      if (childId === undefined || !walk(c, childId, ctx)) return false;
      map.parentOf.set(childId, id);
      j++;
    }
    return j === n.children.length;
  };
  return walk(root, rootId, false) ? map : null;
}
