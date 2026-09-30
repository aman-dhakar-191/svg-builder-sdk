import type { NodeId, SvgNode } from "./types.js";

/**
 * Low-level, reversible changes. Every command is compiled into a list of
 * these; applying a mutation returns its exact inverse. History stores both
 * directions, so redo replays the same node IDs that the original run created.
 */
export type Mutation =
  | { kind: "insert"; parent: NodeId; index: number; nodes: SvgNode[] }
  | { kind: "remove"; id: NodeId }
  | { kind: "attrs"; id: NodeId; attrs: Record<string, string> }
  | { kind: "text"; id: NodeId; text: string }
  | { kind: "move"; id: NodeId; parent: NodeId; index: number };

export function cloneNode(node: SvgNode): SvgNode {
  const copy: SvgNode = {
    id: node.id,
    tag: node.tag,
    attrs: { ...node.attrs },
    children: [...node.children],
    parent: node.parent,
  };
  if (node.text !== undefined) copy.text = node.text;
  if (node.range) copy.range = { ...node.range };
  if (node.attrRanges) {
    copy.attrRanges = Object.fromEntries(
      Object.entries(node.attrRanges).map(([k, r]) => [k, { ...r }]),
    );
  }
  return copy;
}

function mustGet(nodes: Map<NodeId, SvgNode>, id: NodeId): SvgNode {
  const node = nodes.get(id);
  // Commands validate before mutating, so this only fires on an internal bug.
  if (!node) throw new Error(`internal: node ${id} missing`);
  return node;
}

/** Applies `m` to `nodes` in place and returns the mutation that undoes it. */
export function applyMutation(nodes: Map<NodeId, SvgNode>, m: Mutation): Mutation {
  switch (m.kind) {
    case "insert": {
      const parent = mustGet(nodes, m.parent);
      const [top] = m.nodes;
      if (!top) throw new Error("internal: empty insert");
      for (const n of m.nodes) nodes.set(n.id, cloneNode(n));
      mustGet(nodes, top.id).parent = parent.id;
      parent.children.splice(m.index, 0, top.id);
      return { kind: "remove", id: top.id };
    }
    case "remove": {
      const node = mustGet(nodes, m.id);
      const parent = mustGet(nodes, node.parent!);
      const index = parent.children.indexOf(node.id);
      const subtree: SvgNode[] = [];
      const collect = (id: NodeId) => {
        const n = mustGet(nodes, id);
        subtree.push(cloneNode(n));
        n.children.forEach(collect);
      };
      collect(node.id);
      for (const n of subtree) nodes.delete(n.id);
      parent.children.splice(index, 1);
      return { kind: "insert", parent: parent.id, index, nodes: subtree };
    }
    case "attrs": {
      const node = mustGet(nodes, m.id);
      const previous = node.attrs;
      node.attrs = { ...m.attrs };
      return { kind: "attrs", id: m.id, attrs: previous };
    }
    case "text": {
      const node = mustGet(nodes, m.id);
      const previous = node.text ?? "";
      node.text = m.text;
      return { kind: "text", id: m.id, text: previous };
    }
    case "move": {
      const node = mustGet(nodes, m.id);
      const oldParent = mustGet(nodes, node.parent!);
      const oldIndex = oldParent.children.indexOf(node.id);
      oldParent.children.splice(oldIndex, 1);
      const newParent = mustGet(nodes, m.parent);
      newParent.children.splice(m.index, 0, node.id);
      node.parent = newParent.id;
      return { kind: "move", id: m.id, parent: oldParent.id, index: oldIndex };
    }
  }
}
