import { beforeEach, describe, expect, it } from "vitest";
import { createDocument, formatPath, nearestOnPath, parsePath, type SvgDocument } from "../src/index.js";
import { expectNoChange, expectRoundTrip, ok } from "./helpers.js";

let doc: SvgDocument;
beforeEach(() => {
  doc = createDocument();
});

const add = (tag: string, attrs: Record<string, string> = {}, parent?: string) =>
  ok(doc.execute({ op: "add", tag, attrs, ...(parent ? { parent } : {}) })).id;

describe("parsePath / formatPath", () => {
  it("normalizes to absolute M L C Q A Z", () => {
    const segs = parsePath("m10 10 h20 v5 s5 5 10 0 t10 0 a5 5 0 0 1 10 0 z l5 5");
    expect(segs.map((s) => s.cmd)).toEqual(["M", "L", "L", "C", "Q", "A", "Z", "L"]);
    expect(segs[1]).toEqual({ cmd: "L", p: [30, 10] });
    expect(segs[2]).toEqual({ cmd: "L", p: [30, 15] });
    expect(segs[3]).toEqual({ cmd: "C", c1: [30, 15], c2: [35, 20], p: [40, 15] });
    expect(segs[5]).toMatchObject({ cmd: "A", rx: 5, ry: 5, largeArc: false, sweep: true, p: [60, 15] });
    expect(segs[7]).toEqual({ cmd: "L", p: [15, 15] }); // after Z the pen is back at the subpath start
    expect(formatPath(segs)).toBe("M10 10 L30 10 L30 15 C30 15 35 20 40 15 Q40 15 50 15 A5 5 0 0 1 60 15 Z L15 15");
  });

  it("round-trips its own output", () => {
    const d = "M0 0 C1.5 2 3 4 5 6 Q7 8 9 10 A1 2 30 1 0 11 12 Z";
    expect(formatPath(parsePath(d))).toBe(d);
  });
});

describe("pathEdit", () => {
  it("moves an end point with its handles, as one undo step", () => {
    const p = add("path", { d: "M0 0 C10 0 20 10 30 10 C40 10 50 0 60 0", fill: "none" });
    const r = expectRoundTrip(doc, { op: "pathEdit", id: p, moves: [{ seg: 1, point: "p", to: [30, 20] }] });
    expect(r.d).toBe("M0 0 C10 0 20 20 30 20 C40 20 50 0 60 0");
    expect(doc.getNode(p)!.attrs).toEqual({ d: r.d, fill: "none" });
  });

  it("moves control points, or only the point when handles is false", () => {
    const p = add("path", { d: "M0 0 C10 0 20 10 30 10 Q40 0 50 0" });
    ok(doc.execute({ op: "pathEdit", id: p, moves: [{ seg: 1, point: "c1", to: [5, -5] }, { seg: 2, point: "c", to: [40, 20] }] }));
    expect(doc.getNode(p)!.attrs.d).toBe("M0 0 C5 -5 20 10 30 10 Q40 20 50 0");
    ok(doc.execute({ op: "pathEdit", id: p, moves: [{ seg: 1, point: "p", to: [30, 0] }], handles: false }));
    expect(doc.getNode(p)!.attrs.d).toBe("M0 0 C5 -5 20 10 30 0 Q40 20 50 0");
  });

  it("keeps closed shapes closed when their start moves", () => {
    const p = add("path", { d: "M0 0 L10 0 L10 10 L0 0 Z" });
    ok(doc.execute({ op: "pathEdit", id: p, moves: [{ seg: 0, point: "p", to: [-5, -5] }] }));
    expect(doc.getNode(p)!.attrs.d).toBe("M-5 -5 L10 0 L10 10 L-5 -5 Z");
  });

  it("refuses bad targets and leaves no trace", () => {
    const r = add("rect", { width: "5", height: "5" });
    const p = add("path", { d: "M0 0 L10 0 Z" });
    expect(expectNoChange(doc, { op: "pathEdit", id: r, moves: [{ seg: 0, point: "p", to: [1, 1] }] }).code).toBe("NOT_A_PATH");
    expect(expectNoChange(doc, { op: "pathEdit", id: p, moves: [{ seg: 9, point: "p", to: [1, 1] }] }).code).toBe("INDEX_OUT_OF_RANGE");
    expect(expectNoChange(doc, { op: "pathEdit", id: p, moves: [{ seg: 1, point: "c1", to: [1, 1] }] }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "pathEdit", id: p, moves: [{ seg: 2, point: "p", to: [1, 1] }] }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "pathEdit", id: p, moves: [] }).code).toBe("INVALID_COMMAND");
    const bad = add("path", { d: "M0 0 L" });
    expect(expectNoChange(doc, { op: "pathEdit", id: bad, moves: [{ seg: 0, point: "p", to: [1, 1] }] }).code).toBe("INVALID_PATH");
  });
});

describe("convertToPath", () => {
  it("converts each basic shape, keeping other attributes in order, position and children", () => {
    const g = add("g");
    const before = add("circle", { r: "1" }, g);
    const rect = add("rect", { id: "box", x: "10", y: "20", width: "30", height: "40", fill: "red", rx: "5" }, g);
    const title = add("title", {}, rect);
    add("circle", { r: "2" }, g);
    const r = expectRoundTrip(doc, { op: "convertToPath", id: rect });
    const node = doc.getNode(r.id)!;
    expect(node.tag).toBe("path");
    expect(node.attrs).toEqual({ id: "box", fill: "red", d: r.d });
    expect(r.d).toBe("M15 20 H35 A5 5 0 0 1 40 25 V55 A5 5 0 0 1 35 60 H15 A5 5 0 0 1 10 55 V25 A5 5 0 0 1 15 20 Z");
    expect(doc.getNode(g)!.children.indexOf(r.id)).toBe(doc.getNode(g)!.children.indexOf(before) + 1);
    expect(node.children).toEqual([title]);
    expect(doc.getNode(rect)).toBeUndefined();
  });

  it.each([
    ["rect", { width: "4", height: "2" }, "M0 0 H4 V2 H0 Z"],
    ["circle", { cx: "5", cy: "5", r: "2" }, "M3 5 A2 2 0 1 1 7 5 A2 2 0 1 1 3 5 Z"],
    ["ellipse", { cx: "0", cy: "0", rx: "3", ry: "1" }, "M-3 0 A3 1 0 1 1 3 0 A3 1 0 1 1 -3 0 Z"],
    ["line", { x1: "1", y1: "2", x2: "3", y2: "4", stroke: "black" }, "M1 2 L3 4"],
    ["polyline", { points: "0,0 5,5 10,0" }, "M0 0 L5 5 L10 0"],
    ["polygon", { points: "0 0 5 5 10 0" }, "M0 0 L5 5 L10 0 Z"],
  ])("%s", (tag, attrs, d) => {
    const id = add(tag, attrs);
    expect(ok(doc.execute({ op: "convertToPath", id })).d).toBe(d);
  });

  it("refuses what it cannot convert exactly", () => {
    const pct = add("rect", { width: "50%", height: "10" });
    const text = add("text");
    const zero = add("circle", { r: "0" });
    expect(expectNoChange(doc, { op: "convertToPath", id: pct }).code).toBe("NOT_CONVERTIBLE");
    expect(expectNoChange(doc, { op: "convertToPath", id: text }).code).toBe("NOT_CONVERTIBLE");
    expect(expectNoChange(doc, { op: "convertToPath", id: zero }).code).toBe("NOT_CONVERTIBLE");
    expect(expectNoChange(doc, { op: "convertToPath", id: doc.root }).code).toBe("ROOT_NOT_ALLOWED");
  });
});

describe("boolean", () => {
  const square = (x: number, y: number, extra: Record<string, string> = {}) => add("rect", { x: String(x), y: String(y), width: "10", height: "10", ...extra });

  it.each([
    ["union", "M0 0 L10 0 L10 5 L15 5 L15 15 L5 15 L5 10 L0 10 Z"],
    ["subtract", "M0 0 L10 0 L10 5 L5 5 L5 10 L0 10 Z"],
    ["intersect", "M10 10 L5 10 L5 5 L10 5 Z"],
    ["exclude", "M0 0 L10 0 L10 5 L5 5 L5 10 L0 10 Z M10 10 L5 10 L5 15 L15 15 L15 5 L10 5 Z"],
  ] as const)("%s of two overlapping squares, one undo step", (operation, d) => {
    const a = square(0, 0, { fill: "red", id: "a" });
    const b = square(5, 5, { fill: "blue" });
    const r = expectRoundTrip(doc, { op: "boolean", operation, ids: [b, a] }); // order of ids does not matter
    expect(r.d).toBe(d);
    // The bottom shape's style and place; operands gone.
    expect(doc.getNode(r.id)).toMatchObject({ tag: "path", attrs: { fill: "red", id: "a", d } });
    expect(doc.getNode(doc.root)!.children).toEqual([r.id]);
    expect(doc.getNode(a)).toBeUndefined();
    expect(doc.getNode(b)).toBeUndefined();
  });

  it("works across transforms, in the bottom shape's own coordinates", () => {
    const a = square(0, 0, { transform: "translate(100 0)" });
    const b = square(0, 0, { transform: "translate(105 5)" });
    const r = ok(doc.execute({ op: "boolean", operation: "intersect", ids: [a, b] }));
    expect(doc.getNode(r.id)!.attrs).toMatchObject({ transform: "translate(100 0)", d: "M10 10 L5 10 L5 5 L10 5 Z" });
  });

  it("combines curves (circles) and keeps other shapes out", () => {
    const c1 = add("circle", { cx: "0", cy: "0", r: "10" });
    const c2 = add("circle", { cx: "10", cy: "0", r: "10" });
    const other = add("rect", { width: "1", height: "1" });
    const r = ok(doc.execute({ op: "boolean", operation: "union", ids: [c1, c2] }));
    expect(r.d).toMatch(/^M.* C.* Z$/);
    expect(doc.getNode(doc.root)!.children).toEqual([r.id, other]);
  });

  it("refuses what it cannot do, with nothing changed", () => {
    const a = square(0, 0);
    const far = square(50, 50);
    const g = add("g");
    const inner = square(0, 0);
    const t = add("text");
    ok(doc.execute({ op: "move", id: inner, parent: g, index: 0 }));
    expect(expectNoChange(doc, { op: "boolean", operation: "intersect", ids: [a, far] }).code).toBe("EMPTY_RESULT");
    expect(expectNoChange(doc, { op: "boolean", operation: "union", ids: [a] }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "boolean", operation: "melt", ids: [a, far] }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "boolean", operation: "union", ids: [a, inner] }).code).toBe("DIFFERENT_PARENTS");
    expect(expectNoChange(doc, { op: "boolean", operation: "union", ids: [a, t] }).code).toBe("NOT_CONVERTIBLE");
    expect(expectNoChange(doc, { op: "boolean", operation: "union", ids: [a, g] }).code).toBe("NOT_CONVERTIBLE");
  });
});

describe("simplify", () => {
  it("reduces points of a dense path, as one undo step", () => {
    const pts = Array.from({ length: 101 }, (_, i) => `${i} ${Math.round(Math.sin(i / 10) * 1000) / 100}`);
    const p = add("path", { d: `M${pts.join(" L")}`, fill: "none" });
    const r = expectRoundTrip(doc, { op: "simplify", id: p, tolerance: 0.5 });
    expect(r.nodes.before).toBe(101);
    expect(r.nodes.after).toBeLessThan(15);
    expect(r.d).toMatch(/^M0 0 C/);
  });

  it("validates", () => {
    const r = add("rect", { width: "1", height: "1" });
    const p = add("path", { d: "M0 0 L10 10" });
    expect(expectNoChange(doc, { op: "simplify", id: r }).code).toBe("NOT_A_PATH");
    expect(expectNoChange(doc, { op: "simplify", id: p, tolerance: 0 }).code).toBe("INVALID_COMMAND");
  });
});

describe("pathNode", () => {
  const d = (id: string) => doc.getNode(id)!.attrs.d;
  const segs = (id: string) => parsePath(d(id)!);

  it("inserts a node on a line, a cubic, a quadratic and an arc without changing the outline", () => {
    const p = add("path", { d: "M0 0 L10 0 C10 10 20 10 20 0 Q30 10 40 0 A10 10 0 0 1 60 0" });
    expect(expectRoundTrip(doc, { op: "pathNode", id: p, action: "insert", seg: 1, t: 0.5 }).d).toBe("M0 0 L5 0 L10 0 C10 10 20 10 20 0 Q30 10 40 0 A10 10 0 0 1 60 0");
    ok(doc.execute({ op: "pathNode", id: p, action: "insert", seg: 3, t: 0.5 }));
    // De Casteljau at t=0.5: the midpoint of this symmetric curve is (15, 7.5).
    expect(segs(p)[3]).toEqual({ cmd: "C", c1: [10, 5], c2: [12.5, 7.5], p: [15, 7.5] });
    expect(segs(p)[4]).toEqual({ cmd: "C", c1: [17.5, 7.5], c2: [20, 5], p: [20, 0] });
    ok(doc.execute({ op: "pathNode", id: p, action: "insert", seg: 5, t: 0.5 }));
    expect(segs(p)[5]).toEqual({ cmd: "Q", c: [25, 5], p: [30, 5] });
    ok(doc.execute({ op: "pathNode", id: p, action: "insert", seg: 7, t: 0.5 }));
    // A half circle from (40,0) to (60,0), sweep 1: its middle is the top, (50, -10).
    const [a1, a2] = [segs(p)[7]!, segs(p)[8]!];
    expect(a1).toMatchObject({ cmd: "A", rx: 10, ry: 10, largeArc: false, sweep: true });
    expect((a1 as { p: number[] }).p[0]).toBeCloseTo(50);
    expect((a1 as { p: number[] }).p[1]).toBeCloseTo(-10);
    expect(a2).toMatchObject({ cmd: "A", largeArc: false, p: [60, 0] });
  });

  it("inserts on the implicit closing line of a Z", () => {
    const p = add("path", { d: "M0 0 L10 0 L10 10 Z" });
    expect(expectRoundTrip(doc, { op: "pathNode", id: p, action: "insert", seg: 3, t: 0.5 }).d).toBe("M0 0 L10 0 L10 10 L5 5 Z");
  });

  it("deletes a node: neighbours join, curves keep their outer handles", () => {
    const p = add("path", { d: "M0 0 L10 0 L20 0 C25 5 30 5 35 0" });
    expect(expectRoundTrip(doc, { op: "pathNode", id: p, action: "delete", seg: 1 }).d).toBe("M0 0 L20 0 C25 5 30 5 35 0");
    expect(expectRoundTrip(doc, { op: "pathNode", id: p, action: "delete", seg: 1 }).d).toBe("M0 0 C0 0 30 5 35 0");
  });

  it("deletes the last point of an open path, and the start of a closed one", () => {
    const open = add("path", { d: "M0 0 L10 0 L20 0" });
    expect(expectRoundTrip(doc, { op: "pathNode", id: open, action: "delete", seg: 2 }).d).toBe("M0 0 L10 0");
    const closed = add("path", { d: "M0 0 L10 0 L10 10 L0 10 Z" });
    expect(expectRoundTrip(doc, { op: "pathNode", id: closed, action: "delete", seg: 0 }).d).toBe("M10 0 L10 10 L0 10 L10 0 Z");
    const explicit = add("path", { d: "M0 0 L10 0 L10 10 L0 10 L0 0 Z" });
    // The explicit closing point is the same node as the start.
    expect(expectRoundTrip(doc, { op: "pathNode", id: explicit, action: "delete", seg: 4 }).d).toBe("M10 0 L10 10 L0 10 L10 0 Z");
  });

  it("refuses to leave fewer than two points", () => {
    const p = add("path", { d: "M0 0 L10 0" });
    expect(expectNoChange(doc, { op: "pathNode", id: p, action: "delete", seg: 1 }).code).toBe("TOO_FEW_POINTS");
  });

  it("makes a node smooth (handles in line) and a corner (handles pulled in)", () => {
    const p = add("path", { d: "M0 0 L10 0 L20 10" });
    ok(doc.execute({ op: "pathNode", id: p, action: "node", seg: 1, type: "smooth" }));
    const [, a, b] = segs(p) as [unknown, { c2: number[]; p: number[] }, { c1: number[] }];
    const u = [a.p[0]! - a.c2[0]!, a.p[1]! - a.c2[1]!];
    const v = [b.c1[0]! - a.p[0]!, b.c1[1]! - a.p[1]!];
    expect(u[0]! * v[1]! - u[1]! * v[0]!).toBeCloseTo(0); // collinear
    expect(u[0]! * v[0]! + u[1]! * v[1]!).toBeGreaterThan(0); // same direction through the node
    expect(expectRoundTrip(doc, { op: "pathNode", id: p, action: "node", seg: 1, type: "corner" }).d).toMatch(/C[\d.]+ [\d.]+ 10 0 10 0 C10 0 /);
    const end = add("path", { d: "M0 0 L10 0" });
    expect(expectNoChange(doc, { op: "pathNode", id: end, action: "node", seg: 1, type: "smooth" }).code).toBe("INVALID_COMMAND");
  });

  it("changes a segment between line and curve; an arc becomes cubics", () => {
    const p = add("path", { d: "M0 0 L30 0 A10 10 0 0 1 50 0" });
    expect(expectRoundTrip(doc, { op: "pathNode", id: p, action: "segment", seg: 1, type: "curve" }).d).toBe("M0 0 C10 0 20 0 30 0 A10 10 0 0 1 50 0");
    expect(expectRoundTrip(doc, { op: "pathNode", id: p, action: "segment", seg: 1, type: "line" }).d).toBe("M0 0 L30 0 A10 10 0 0 1 50 0");
    const r = ok(doc.execute({ op: "pathNode", id: p, action: "segment", seg: 2, type: "curve" }));
    expect(r.d).not.toContain("A");
    expect(segs(p).at(-1)).toMatchObject({ cmd: "C", p: [50, 0] });
  });

  it("dragging a handle of a smooth node turns the other handle with it", () => {
    const p = add("path", { d: "M0 0 C0 10 10 10 20 10 C30 10 40 10 40 0" });
    const r = ok(doc.execute({ op: "pathEdit", id: p, moves: [{ seg: 1, point: "c2", to: [10, 0] }] }));
    // The out handle (30,10) keeps its length 10 and points away from (10,0) through (20,10).
    const out = (parsePath(r.d)[2] as { c1: number[] }).c1;
    expect(out[0]).toBeCloseTo(20 + 10 / Math.SQRT2);
    expect(out[1]).toBeCloseTo(10 + 10 / Math.SQRT2);
    // A corner (handles not in line) is left alone, as is any drag with handles: false.
    const c = add("path", { d: "M0 0 C0 10 10 10 20 10 C20 20 40 10 40 0" });
    expect(ok(doc.execute({ op: "pathEdit", id: c, moves: [{ seg: 1, point: "c2", to: [10, 0] }] })).d).toContain("C20 20 40 10 40 0");
  });

  it("rejects bad input without changing anything", () => {
    const p = add("path", { d: "M0 0 L10 0 Z" });
    expect(expectNoChange(doc, { op: "pathNode", id: p, action: "insert", seg: 1, t: 1 }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "pathNode", id: p, action: "delete", seg: 9 }).code).toBe("INDEX_OUT_OF_RANGE");
    expect(expectNoChange(doc, { op: "pathNode", id: p, action: "node", seg: 1, type: "round" }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "pathNode", id: p, action: "grow", seg: 1 }).code).toBe("INVALID_COMMAND");
    const r = add("rect", { width: "5", height: "5" });
    expect(expectNoChange(doc, { op: "pathNode", id: r, action: "delete", seg: 1 }).code).toBe("NOT_A_PATH");
  });
});

describe("nearestOnPath", () => {
  it("finds the segment and t closest to a point, on lines, curves, arcs and the closing line", () => {
    const segs = parsePath("M0 0 L10 0 C10 10 20 10 20 0 A10 10 0 0 1 40 0 Z");
    expect(nearestOnPath(segs, [5, 1])).toMatchObject({ seg: 1 });
    expect(nearestOnPath(segs, [5, 1])!.t).toBeCloseTo(0.5, 3);
    const c = nearestOnPath(segs, [15, 9])!;
    expect(c.seg).toBe(2);
    expect(c.t).toBeCloseTo(0.5, 2); // the top of the symmetric curve is at (15, 7.5)
    const a = nearestOnPath(segs, [30, -12])!;
    expect(a.seg).toBe(3);
    expect(a.point[1]).toBeCloseTo(-10, 2);
    const z = nearestOnPath(segs, [30, 2])!;
    expect(z).toMatchObject({ seg: 4 }); // the implicit line back to (0, 0)
  });
});
