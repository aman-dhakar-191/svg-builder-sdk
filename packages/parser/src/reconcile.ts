import { TEXT_TAG, type InputTree, type NodeId, type SvgDocument, type TreeNode } from "@svg-editor/model";
import type { ParsedElement } from "./parse.js";
import { toInputTree } from "./source-map.js";

export interface ReconcileResult {
  /** The new parse, with `id` set wherever an existing node was recognized. */
  tree: InputTree;
  /** Old IDs carried over. */
  kept: number;
  /** New nodes that got no old ID. */
  created: number;
  /** Old IDs with no counterpart (deleted, or lost to a big edit). */
  removed: NodeId[];
}

/**
 * Matches a fresh parse against the current model so node IDs survive code
 * edits. Heuristic, in order:
 *   1. root to root;
 *   2. elements with the same tag and the same unique `id` attribute, anywhere;
 *   3. within each matched parent, an alignment of the remaining children
 *      (same tag required, weighted by attribute/text similarity);
 *   4. leftovers with an identical subtree anywhere (cut and paste elsewhere).
 * Large rewrites fall through to new IDs; callers should clear selection then.
 */
export function reconcile(doc: SvgDocument, root: ParsedElement): ReconcileResult {
  const oldRoot = doc.getTree()!;
  const newRoot = toInputTree(root);
  const matchedOld = new Set<NodeId>();
  const queue: [TreeNode, InputTree][] = [];
  const match = (o: TreeNode, n: InputTree) => {
    n.id = o.id;
    matchedOld.add(o.id);
    queue.push([o, n]);
  };

  // 2. unique id attributes
  const byIdAttr = (nodes: (TreeNode | InputTree)[]) => {
    const seen = new Map<string, TreeNode | InputTree | null>();
    for (const n of nodes) {
      const key = n.attrs.id === undefined ? undefined : `${n.tag}#${n.attrs.id}`;
      if (key) seen.set(key, seen.has(key) ? null : n);
    }
    return seen;
  };
  const oldAll = flatten(oldRoot);
  const newAll = flatten(newRoot);
  match(oldRoot, newRoot);
  const oldKeys = byIdAttr(oldAll.slice(1));
  for (const [key, n] of byIdAttr(newAll.slice(1))) {
    const o = oldKeys.get(key);
    if (o && n) match(o as TreeNode, n as InputTree);
  }

  // 3. align children of matched pairs
  const drain = () => {
    while (queue.length > 0) {
      const [o, n] = queue.shift()!;
      const oc = o.children.filter((c) => !matchedOld.has(c.id));
      const nc = n.children.filter((c) => c.id === undefined);
      for (const [i, j] of align(oc, nc)) match(oc[i]!, nc[j]!);
    }
  };
  drain();

  // 4. identical subtrees that moved to another parent
  const leftovers = new Map<string, TreeNode[]>();
  for (const o of oldAll) {
    if (matchedOld.has(o.id)) continue;
    const sig = signature(o);
    leftovers.set(sig, [...(leftovers.get(sig) ?? []), o]);
  }
  for (const n of newAll) {
    if (n.id !== undefined) continue;
    const candidates = leftovers.get(signature(n));
    const o = candidates?.find((c) => !matchedOld.has(c.id));
    if (o) {
      match(o, n);
      drain();
    }
  }

  const kept = newAll.filter((n) => n.id !== undefined).length;
  return {
    tree: newRoot,
    kept,
    created: newAll.length - kept,
    removed: oldAll.filter((o) => !matchedOld.has(o.id)).map((o) => o.id),
  };
}

function flatten<T extends { children: T[] }>(root: T): T[] {
  const out: T[] = [];
  const walk = (n: T) => {
    out.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

function signature(n: TreeNode | InputTree): string {
  return JSON.stringify([n.tag, n.attrs, n.text ?? null, n.children.map(signature)]);
}

function similarity(a: TreeNode, b: InputTree): number {
  if (a.tag === TEXT_TAG) return a.text === b.text ? 1 : 0.5;
  const pa = Object.entries(a.attrs).map(([k, v]) => `${k}=${v}`);
  const pb = new Set(Object.entries(b.attrs).map(([k, v]) => `${k}=${v}`));
  const shared = pa.filter((p) => pb.has(p)).length;
  const union = pa.length + pb.size - shared;
  const attrScore = union === 0 ? 1 : shared / union;
  const childScore = a.children.length === b.children.length ? 0.1 : 0;
  return attrScore + childScore;
}

/** Order-preserving alignment maximizing total similarity; same tag required. */
function align(oldKids: TreeNode[], newKids: InputTree[]): [number, number][] {
  const n = oldKids.length;
  const m = newKids.length;
  if (n === 0 || m === 0) return [];
  // score[i][j]: best total for oldKids[i..] vs newKids[j..]
  const score: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let best = Math.max(score[i + 1]![j]!, score[i]![j + 1]!);
      if (oldKids[i]!.tag === newKids[j]!.tag) best = Math.max(best, 1 + similarity(oldKids[i]!, newKids[j]!) + score[i + 1]![j + 1]!);
      score[i]![j] = best;
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const here = score[i]![j]!;
    if (oldKids[i]!.tag === newKids[j]!.tag && here === 1 + similarity(oldKids[i]!, newKids[j]!) + score[i + 1]![j + 1]!) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (here === score[i + 1]![j]!) i++;
    else j++;
  }
  return pairs;
}
