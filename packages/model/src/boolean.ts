/// <reference path="./paper-core.d.ts" />
import paperCore from "paper/dist/paper-core.js";
import type { Matrix } from "./geometry.js";
import { formatPath, parsePath } from "./path.js";

/**
 * Shape booleans and path simplification with paper.js (MIT). Only its
 * geometry is used: no canvas, no rendering, no DOM, so it runs headlessly.
 * Inputs and outputs are SVG path data; the model owns everything else.
 */

export type BooleanOperation = "union" | "subtract" | "intersect" | "exclude";

/** Decimals in results: enough for any screen, short enough for a readable file. */
const PRECISION = 3;

type Paper = paper.PaperScope;
type PathLike = paper.PathItem;

let ready: Paper | null = null;
function getPaper(): Paper {
  if (!ready) {
    // paper.js needs a current project; a 1x1 one without a view is enough for geometry.
    paperCore.setup(new paperCore.Size(1, 1));
    ready = paperCore;
  }
  return ready;
}

function load(d: string, m: Matrix): PathLike {
  const p = getPaper();
  const item = new p.CompoundPath({ pathData: d, insert: false });
  item.transform(new p.Matrix(m[0], m[1], m[2], m[3], m[4], m[5]));
  return item;
}

/** paper.js has getPathData(matrix, precision) at runtime; its typings only list the pathData property. */
type WithPathData = { getPathData(matrix: paper.Matrix, precision: number): string };

function toData(item: PathLike): string {
  const raw = (item as unknown as WithPathData).getPathData(new (getPaper().Matrix)(), PRECISION);
  return raw.trim() === "" ? "" : formatPath(parsePath(raw));
}

/**
 * Combines shapes given as path data plus a matrix each (into a common
 * space). "subtract" removes all later shapes from the first. Returns "" when
 * the result is empty (e.g. shapes that do not overlap, intersected).
 */
export function booleanPaths(shapes: { d: string; matrix: Matrix }[], op: BooleanOperation): string {
  const [first, ...rest] = shapes.map((s) => load(s.d, s.matrix));
  let acc = first!;
  for (const next of rest) {
    const opts = { insert: false };
    acc =
      op === "union" ? acc.unite(next, opts)
      : op === "subtract" ? acc.subtract(next, opts)
      : op === "intersect" ? acc.intersect(next, opts)
      : acc.exclude(next, opts);
  }
  // Not acc.area: it is signed, and exclude's pieces can cancel to ~0.
  return toData(acc);
}

/**
 * Fewer points, same look: fits smooth curves through each subpath.
 * `tolerance` is the largest allowed deviation, in the path's units.
 */
export function simplifyPathData(d: string, tolerance: number): string {
  const p = getPaper();
  const item = new p.CompoundPath({ pathData: d, insert: false });
  for (const child of item.children as paper.Path[]) child.simplify(tolerance);
  return toData(item);
}

/** Number of end points (nodes) in path data. */
export function countNodes(d: string): number {
  return parsePath(d).filter((s) => s.cmd !== "Z").length;
}
