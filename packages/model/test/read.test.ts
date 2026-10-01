import { beforeEach, describe, expect, it } from "vitest";
import { createDocument, TEXT_TAG, type SvgDocument } from "../src/index.js";
import { ok } from "./helpers.js";

let doc: SvgDocument;
let ids: Record<string, string>;
beforeEach(() => {
  doc = createDocument({ rootAttrs: { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 100 100" } });
  const add = (tag: string, attrs: Record<string, string>, parent?: string) =>
    ok(doc.execute({ op: "add", tag, attrs, ...(parent ? { parent } : {}) })).id;
  const g = add("g", { fill: "red" });
  ids = {
    g,
    c1: add("circle", { r: "5", fill: "red" }, g),
    c2: add("circle", { r: "6", fill: "blue" }),
    r: add("rect", { width: "4", height: "4", stroke: "black" }, g),
    t: add("text", {}),
  };
  ok(doc.execute({ op: "setText", id: ids.t!, text: "Hi" }));
});

describe("getNode", () => {
  it("returns plain data and undefined for unknown IDs", () => {
    expect(doc.getNode(ids.c1!)).toEqual({ id: ids.c1, tag: "circle", attrs: { r: "5", fill: "red" }, children: [], parent: ids.g });
    expect(doc.getNode("n_999")).toBeUndefined();
  });

  it("returns copies that cannot mutate the document", () => {
    const n = doc.getNode(ids.g!)!;
    n.attrs.fill = "green";
    n.children.length = 0;
    expect(doc.getNode(ids.g!)!.attrs.fill).toBe("red");
    expect(doc.getNode(ids.g!)!.children).toHaveLength(2);
  });
});

describe("getTree", () => {
  it("returns a nested plain-data tree", () => {
    const tree = doc.getTree()!;
    expect(tree.tag).toBe("svg");
    expect(tree.children.map((c) => c.tag)).toEqual(["g", "circle", "text"]);
    expect(tree.children[0]!.children.map((c) => c.id)).toEqual([ids.c1, ids.r]);
    expect(tree.children[2]!.children[0]).toEqual({ id: expect.any(String), tag: TEXT_TAG, attrs: {}, text: "Hi", children: [] });
    expect(JSON.parse(JSON.stringify(tree))).toEqual(tree); // serializable, no DOM refs
  });

  it("supports subtrees and unknown IDs", () => {
    expect(doc.getTree(ids.g!)!.children).toHaveLength(2);
    expect(doc.getTree("n_999")).toBeUndefined();
  });
});

describe("query", () => {
  it("matches by tag in document order", () => {
    expect(doc.query({ tag: "circle" })).toEqual([ids.c1, ids.c2]);
    expect(doc.query({ tag: "svg" })).toEqual([doc.root]);
  });

  it("matches attribute values and presence", () => {
    expect(doc.query({ attr: { fill: "red" } })).toEqual([ids.g, ids.c1]);
    expect(doc.query({ tag: "circle", attr: { fill: "red" } })).toEqual([ids.c1]);
    expect(doc.query({ attr: { stroke: true } })).toEqual([ids.r]);
  });

  it("restricts to descendants with `within`", () => {
    expect(doc.query({ within: ids.g!, attr: { fill: "red" } })).toEqual([ids.c1]);
    expect(doc.query({ within: "n_999" })).toEqual([]);
  });

  it("returns only elements unless text nodes are asked for", () => {
    expect(doc.query()).toHaveLength(6);
    expect(doc.query({ tag: TEXT_TAG })).toHaveLength(1);
  });
});

describe("toSvg", () => {
  it("serializes compactly by default", () => {
    expect(doc.toSvg()).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g fill="red"><circle r="5" fill="red"/><rect width="4" height="4" stroke="black"/></g><circle r="6" fill="blue"/><text>Hi</text></svg>',
    );
  });

  it("pretty-prints without touching text content", () => {
    expect(doc.toSvg({ pretty: true })).toBe(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
        '  <g fill="red">',
        '    <circle r="5" fill="red"/>',
        '    <rect width="4" height="4" stroke="black"/>',
        "  </g>",
        '  <circle r="6" fill="blue"/>',
        "  <text>Hi</text>",
        "</svg>",
      ].join("\n"),
    );
  });

  it("escapes attribute values", () => {
    ok(doc.execute({ op: "set", id: ids.r!, attrs: { "data-x": 'a"b<c&d' } }));
    expect(doc.toSvg()).toContain('data-x="a&quot;b&lt;c&amp;d"');
  });
});

describe("getBBox", () => {
  it("computes primitives in their own user space", () => {
    const add = (tag: string, attrs: Record<string, string>) => ok(doc.execute({ op: "add", tag, attrs })).id;
    const box = (id: string) => ok(doc.getBBox(id));
    expect(box(add("rect", { x: "1", y: "2", width: "3", height: "4", transform: "scale(9)" }))).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(box(add("circle", { cx: "10", cy: "10", r: "5" }))).toEqual({ x: 5, y: 5, width: 10, height: 10 });
    expect(box(add("ellipse", { cx: "0", cy: "0", rx: "4", ry: "2" }))).toEqual({ x: -4, y: -2, width: 8, height: 4 });
    expect(box(add("ellipse", { rx: "3" }))).toEqual({ x: -3, y: -3, width: 6, height: 6 });
    expect(box(add("line", { x1: "5", y1: "0", x2: "0", y2: "10" }))).toEqual({ x: 0, y: 0, width: 5, height: 10 });
    expect(box(add("polygon", { points: "0,0 10,5 3,-2" }))).toEqual({ x: 0, y: -2, width: 10, height: 7 });
    expect(box(add("rect", { width: "10px", height: "2" }))).toEqual({ x: 0, y: 0, width: 10, height: 2 });
  });

  it("unions group children through their transforms", () => {
    const g = ok(doc.execute({ op: "add", tag: "g", attrs: {} })).id;
    ok(doc.execute({ op: "add", tag: "rect", parent: g, attrs: { width: "10", height: "10" } }));
    ok(doc.execute({ op: "add", tag: "rect", parent: g, attrs: { width: "10", height: "10", transform: "translate(20 5)" } }));
    expect(ok(doc.getBBox(g))).toEqual({ x: 0, y: 0, width: 30, height: 15 });
  });

  it("measures paths by their outline, not their control points", () => {
    const box = (d: string) => ok(doc.getBBox(ok(doc.execute({ op: "add", tag: "path", attrs: { d } })).id));
    expect(box("M10 10 H50 V30 Z")).toEqual({ x: 10, y: 10, width: 40, height: 20 });
    // The curve peaks at y = 75 (3/4 of the way to its handles).
    const c = box("M0 100 C0 0 100 0 100 100");
    expect(c.x).toBe(0);
    expect(c.width).toBe(100);
    expect(c.y).toBeCloseTo(25, 9);
    expect(c.height).toBeCloseTo(75, 9);
    expect(box("M0 0 Q50 100 100 0").height).toBeCloseTo(50, 9);
    const arc = box("M0 50 A50 50 0 0 1 100 50");
    expect(arc.y).toBeCloseTo(0, 1);
    expect(arc.width).toBeCloseTo(100, 6);
  });

  it("skips animations and other non-drawing children of groups", () => {
    const g = ok(doc.execute({ op: "add", tag: "g", attrs: {} })).id;
    ok(doc.execute({ op: "add", tag: "title", parent: g, attrs: {} }));
    ok(doc.execute({ op: "add", tag: "rect", parent: g, attrs: { width: "10", height: "10" } }));
    ok(doc.execute({ op: "add", tag: "animateTransform", parent: g, attrs: { attributeName: "transform", type: "rotate" } }));
    expect(ok(doc.getBBox(g))).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("explains what it cannot compute", () => {
    const p = ok(doc.execute({ op: "add", tag: "path", attrs: { d: "M0 0" } })).id;
    const pct = ok(doc.execute({ op: "add", tag: "rect", attrs: { width: "50%", height: "1" } })).id;
    const r1 = doc.getBBox(p);
    const r2 = doc.getBBox(pct);
    expect(!r1.ok && r1.error.code).toBe("BBOX_UNAVAILABLE");
    expect(!r2.ok && r2.error.message).toMatch(/percentages/);
    const r3 = doc.getBBox("n_999");
    expect(!r3.ok && r3.error.code).toBe("NOT_FOUND");
  });
});
