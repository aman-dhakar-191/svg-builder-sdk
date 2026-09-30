import { beforeEach, describe, expect, it } from "vitest";
import { createDocument, TEXT_TAG, type SvgDocument } from "../src/index.js";
import { err, expectNoChange, expectRoundTrip, ok } from "./helpers.js";

let doc: SvgDocument;
beforeEach(() => {
  doc = createDocument();
});

const add = (tag: string, attrs: Record<string, string> = {}, parent?: string, index?: number) =>
  ok(doc.execute({ op: "add", tag, attrs, ...(parent ? { parent } : {}), ...(index !== undefined ? { index } : {}) })).id;

describe("add", () => {
  it("appends to the root by default and preserves attribute order", () => {
    const { id } = expectRoundTrip(doc, { op: "add", tag: "rect", attrs: { y: "2", x: "1", width: "10" } });
    const node = doc.getNode(id)!;
    expect(node).toMatchObject({ tag: "rect", parent: doc.root, children: [] });
    expect(Object.keys(node.attrs)).toEqual(["y", "x", "width"]);
    expect(doc.getNode(doc.root)!.children).toEqual([id]);
  });

  it("inserts at an index under a given parent", () => {
    const g = add("g");
    const a = add("rect", {}, g);
    const b = add("rect", {}, g);
    const { id } = expectRoundTrip(doc, { op: "add", tag: "circle", attrs: {}, parent: g, index: 1 });
    expect(doc.getNode(g)!.children).toEqual([a, id, b]);
  });

  it("generates unique IDs that are never reused", () => {
    const a = add("rect");
    ok(doc.execute({ op: "delete", ids: [a] }));
    const b = add("rect");
    expect(b).not.toBe(a);
    expect(a).toMatch(/^n_\d+$/);
  });

  it("rejects bad input with specific errors", () => {
    expect(expectNoChange(doc, { op: "add", tag: "not a tag", attrs: {} }).code).toBe("INVALID_TAG");
    expect(expectNoChange(doc, { op: "add", tag: TEXT_TAG, attrs: {} }).code).toBe("INVALID_TAG");
    expect(expectNoChange(doc, { op: "add", tag: "rect", attrs: { x: 10 } }).code).toBe("INVALID_ATTR");
    expect(expectNoChange(doc, { op: "add", tag: "rect", attrs: { "bad name": "1" } }).code).toBe("INVALID_ATTR");
    expect(expectNoChange(doc, { op: "add", tag: "rect", attrs: {}, parent: "n_999" }).code).toBe("NOT_FOUND");
    expect(expectNoChange(doc, { op: "add", tag: "rect", attrs: {}, index: 5 }).code).toBe("INDEX_OUT_OF_RANGE");
    expect(expectNoChange(doc, { op: "add", tag: "rect", attrs: {}, index: 0.5 }).code).toBe("INVALID_COMMAND");
  });

  it("refuses to add under a text node", () => {
    const t = add("text");
    ok(doc.execute({ op: "setText", id: t, text: "hi" }));
    const textNode = doc.getNode(t)!.children[0]!;
    expect(expectNoChange(doc, { op: "add", tag: "rect", attrs: {}, parent: textNode }).code).toBe("NOT_AN_ELEMENT");
  });
});

describe("set", () => {
  it("sets, overwrites in place, appends new attrs, and removes with null", () => {
    const id = add("rect", { x: "1", y: "2", fill: "red" });
    expectRoundTrip(doc, { op: "set", id, attrs: { y: "5", fill: null, stroke: "blue" } });
    const attrs = doc.getNode(id)!.attrs;
    expect(attrs).toEqual({ x: "1", y: "5", stroke: "blue" });
    expect(Object.keys(attrs)).toEqual(["x", "y", "stroke"]);
  });

  it("records nothing when the values do not change", () => {
    const id = add("rect", { x: "1" });
    const v = doc.version;
    ok(doc.execute({ op: "set", id, attrs: { x: "1", y: null } }));
    expect(doc.version).toBe(v);
    doc.undo();
    expect(doc.getNode(id)).toBeUndefined(); // the undo removed the add, not a no-op set
  });

  it("rejects bad input", () => {
    const id = add("rect");
    expect(expectNoChange(doc, { op: "set", id: "n_999", attrs: {} }).code).toBe("NOT_FOUND");
    expect(expectNoChange(doc, { op: "set", id, attrs: { x: 3 } }).code).toBe("INVALID_ATTR");
    expect(expectNoChange(doc, { op: "set", id, attrs: "x=1" }).code).toBe("INVALID_COMMAND");
  });
});

describe("delete", () => {
  it("removes subtrees and undo restores them at the same position with the same IDs", () => {
    const a = add("rect");
    const g = add("g");
    const inner = add("circle", { r: "3" }, g);
    const c = add("line");
    expectRoundTrip(doc, { op: "delete", ids: [g] });
    expect(doc.getNode(g)).toBeUndefined();
    expect(doc.getNode(inner)).toBeUndefined();
    expect(doc.getNode(doc.root)!.children).toEqual([a, c]);
  });

  it("deletes several nodes, ignoring descendants of deleted ancestors and duplicates", () => {
    const g = add("g");
    const inner = add("rect", {}, g);
    const other = add("rect");
    const r = expectRoundTrip(doc, { op: "delete", ids: [inner, g, other, other] });
    expect(r.ids).toEqual([g, other]);
  });

  it("rejects root, unknown IDs and empty lists; partial failure deletes nothing", () => {
    const a = add("rect");
    expect(expectNoChange(doc, { op: "delete", ids: [doc.root] }).code).toBe("ROOT_NOT_ALLOWED");
    expect(expectNoChange(doc, { op: "delete", ids: [a, "n_999"] }).code).toBe("NOT_FOUND");
    expect(expectNoChange(doc, { op: "delete", ids: [] }).code).toBe("INVALID_COMMAND");
    expect(doc.getNode(a)).toBeDefined();
  });
});

describe("move", () => {
  it("reorders within a parent (index = final position)", () => {
    const [a, b, c] = [add("rect"), add("circle"), add("line")];
    expectRoundTrip(doc, { op: "move", id: a, parent: doc.root, index: 2 });
    expect(doc.getNode(doc.root)!.children).toEqual([b, c, a]);
  });

  it("reparents", () => {
    const g = add("g");
    const existing = add("rect", {}, g);
    const r = add("rect");
    expectRoundTrip(doc, { op: "move", id: r, parent: g, index: 0 });
    expect(doc.getNode(g)!.children).toEqual([r, existing]);
    expect(doc.getNode(r)!.parent).toBe(g);
  });

  it("is a no-op when already in place", () => {
    const a = add("rect");
    const v = doc.version;
    ok(doc.execute({ op: "move", id: a, parent: doc.root, index: 0 }));
    expect(doc.version).toBe(v);
  });

  it("rejects cycles, root, bad parents and out-of-range indices", () => {
    const g = add("g");
    const inner = add("g", {}, g);
    const r = add("rect");
    expect(expectNoChange(doc, { op: "move", id: g, parent: inner, index: 0 }).code).toBe("CYCLE");
    expect(expectNoChange(doc, { op: "move", id: g, parent: g, index: 0 }).code).toBe("CYCLE");
    expect(expectNoChange(doc, { op: "move", id: doc.root, parent: g, index: 0 }).code).toBe("ROOT_NOT_ALLOWED");
    expect(expectNoChange(doc, { op: "move", id: r, parent: "n_999", index: 0 }).code).toBe("NOT_FOUND");
    // Same parent: max index is length - 1.
    expect(expectNoChange(doc, { op: "move", id: r, parent: doc.root, index: 2 }).code).toBe("INDEX_OUT_OF_RANGE");
    expect(expectNoChange(doc, { op: "move", id: r, parent: g, index: 2 }).code).toBe("INDEX_OUT_OF_RANGE");
  });
});

describe("group", () => {
  it("wraps siblings in a <g> at the first one's position, in document order", () => {
    const [a, b, c, d] = [add("rect"), add("circle"), add("line"), add("ellipse")];
    const { id } = expectRoundTrip(doc, { op: "group", ids: [d, b] });
    const g = doc.getNode(id)!;
    expect(g.tag).toBe("g");
    expect(g.children).toEqual([b, d]);
    expect(doc.getNode(doc.root)!.children).toEqual([a, id, c]);
  });

  it("requires siblings and rejects root and text nodes", () => {
    const g = add("g");
    const inner = add("rect", {}, g);
    const outer = add("rect");
    expect(expectNoChange(doc, { op: "group", ids: [inner, outer] }).code).toBe("DIFFERENT_PARENTS");
    expect(expectNoChange(doc, { op: "group", ids: [doc.root] }).code).toBe("ROOT_NOT_ALLOWED");
    expect(expectNoChange(doc, { op: "group", ids: [] }).code).toBe("INVALID_COMMAND");
  });
});

describe("ungroup", () => {
  it("moves children to the group's place and removes the group", () => {
    const before = add("line");
    const [x, y] = [add("rect"), add("circle")];
    const after = add("path");
    const { id: g } = ok(doc.execute({ op: "group", ids: [x, y] }));
    const r = expectRoundTrip(doc, { op: "ungroup", id: g });
    expect(r.ids).toEqual([x, y]);
    expect(doc.getNode(g)).toBeUndefined();
    expect(doc.getNode(doc.root)!.children).toEqual([before, x, y, after]);
  });

  it("pushes transform and inherited presentation attributes down without overriding children", () => {
    const g = add("g", { id: "grp", transform: "translate(10 0)", fill: "red", stroke: "blue" });
    const a = add("rect", { fill: "green", transform: "scale(2)" }, g);
    const b = add("circle", {}, g);
    expectRoundTrip(doc, { op: "ungroup", id: g });
    expect(doc.getNode(a)!.attrs).toEqual({ stroke: "blue", fill: "green", transform: "translate(10 0) scale(2)" });
    expect(doc.getNode(b)!.attrs).toEqual({ fill: "red", stroke: "blue", transform: "translate(10 0)" });
  });

  it("refuses when group attributes cannot be pushed down faithfully", () => {
    const g = add("g", { opacity: "0.5", filter: "url(#f)" });
    add("rect", {}, g);
    const e = expectNoChange(doc, { op: "ungroup", id: g });
    expect(e.code).toBe("UNGROUP_LOSSY");
    expect(e.message).toContain('"opacity"');
    expect(e.message).toContain('"filter"');
  });

  it("rejects non-groups", () => {
    const r = add("rect");
    expect(expectNoChange(doc, { op: "ungroup", id: r }).code).toBe("NOT_A_GROUP");
    expect(expectNoChange(doc, { op: "ungroup", id: "n_999" }).code).toBe("NOT_FOUND");
  });
});

describe("transform", () => {
  const t = (id: string) => doc.getNode(id)!.attrs.transform;

  it("translates, folding repeated moves into the leading translate", () => {
    const r = add("rect", { width: "10", height: "10" });
    expectRoundTrip(doc, { op: "transform", id: r, translate: [5, 0] });
    expect(t(r)).toBe("translate(5 0)");
    expectRoundTrip(doc, { op: "transform", id: r, translate: [1.5, -2] });
    expect(t(r)).toBe("translate(6.5 -2)");
  });

  it("keeps the rest of an existing transform when folding a translate", () => {
    const r = add("rect", { transform: "translate(1,2) rotate(45)" });
    ok(doc.execute({ op: "transform", id: r, translate: [1, 1] }));
    expect(t(r)).toBe("translate(2 3) rotate(45)");
  });

  it("prepends rotate/scale so they apply in the parent's space", () => {
    const r = add("rect", { transform: "skewX(10)" });
    expectRoundTrip(doc, { op: "transform", id: r, rotate: 30, scale: [2, 3] });
    expect(t(r)).toBe("rotate(30) scale(2 3) skewX(10)");
  });

  it("rotates and scales about an explicit origin", () => {
    const r = add("rect");
    ok(doc.execute({ op: "transform", id: r, rotate: 90, origin: [10, 20] }));
    expect(t(r)).toBe("rotate(90 10 20)");
    const c = add("circle");
    ok(doc.execute({ op: "transform", id: c, scale: [2, 2], origin: [5, 5] }));
    expect(t(c)).toBe("translate(5 5) scale(2 2) translate(-5 -5)");
  });

  it('resolves origin "center" from the headless bbox, through the existing transform', () => {
    const r = add("rect", { x: "0", y: "0", width: "10", height: "20" });
    expectRoundTrip(doc, { op: "transform", id: r, rotate: 45, origin: "center" });
    expect(t(r)).toBe("rotate(45 5 10)");
    const moved = add("rect", { width: "10", height: "10", transform: "translate(100 0)" });
    ok(doc.execute({ op: "transform", id: moved, rotate: 90, origin: "center" }));
    expect(t(moved)).toBe("rotate(90 105 5) translate(100 0)");
  });

  it("reports specific errors", () => {
    const r = add("rect");
    const p = add("path", { d: "M0 0L10 10" });
    const bad = add("rect", { transform: "wobble(3)" });
    expect(expectNoChange(doc, { op: "transform", id: r }).code).toBe("EMPTY_TRANSFORM");
    expect(expectNoChange(doc, { op: "transform", id: r, translate: [1] }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "transform", id: r, rotate: Number.NaN }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "transform", id: r, scale: [0, 1] }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "transform", id: p, rotate: 10, origin: "center" }).code).toBe("BBOX_UNAVAILABLE");
    expect(expectNoChange(doc, { op: "transform", id: bad, rotate: 10 }).code).toBe("INVALID_TRANSFORM");
  });
});

describe("setText", () => {
  it("creates, replaces and clears the text of an element", () => {
    const t = add("text", { x: "0", y: "10" });
    expectRoundTrip(doc, { op: "setText", id: t, text: "Hello & <bye>" });
    const [child] = doc.getNode(t)!.children;
    expect(doc.getNode(child!)).toMatchObject({ tag: TEXT_TAG, text: "Hello & <bye>", parent: t });
    expect(doc.toSvg()).toContain("<text x=\"0\" y=\"10\">Hello &amp; &lt;bye&gt;</text>");

    expectRoundTrip(doc, { op: "setText", id: t, text: "Changed" });
    expect(doc.getNode(t)!.children).toEqual([child]); // same text node, updated in place
    expect(doc.getNode(child!)!.text).toBe("Changed");

    expectRoundTrip(doc, { op: "setText", id: t, text: "" });
    expect(doc.getNode(t)!.children).toEqual([]);
  });

  it("targets a text node directly", () => {
    const t = add("text");
    ok(doc.execute({ op: "setText", id: t, text: "a" }));
    const child = doc.getNode(t)!.children[0]!;
    expectRoundTrip(doc, { op: "setText", id: child, text: "b" });
    expect(doc.getNode(child)!.text).toBe("b");
  });

  it("refuses to wipe out element children", () => {
    const t = add("text");
    add("tspan", {}, t);
    expect(expectNoChange(doc, { op: "setText", id: t, text: "x" }).code).toBe("HAS_ELEMENT_CHILDREN");
    expect(expectNoChange(doc, { op: "setText", id: t, text: 5 }).code).toBe("INVALID_COMMAND");
  });
});

describe("command validation", () => {
  it("rejects unknown ops and malformed commands", () => {
    expect(expectNoChange(doc, { op: "explode" }).code).toBe("UNKNOWN_OP");
    expect(expectNoChange(doc, { op: "toString" }).code).toBe("UNKNOWN_OP");
    expect(expectNoChange(doc, null).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { tag: "rect" }).code).toBe("INVALID_COMMAND");
  });

  it("errors carry code, message and hint", () => {
    const e = err(doc.execute({ op: "set", id: "n_42", attrs: {} }));
    expect(e).toMatchObject({ code: "NOT_FOUND" });
    expect(e.message).toContain("n_42");
  });
});

describe("replace", () => {
  it("replaces the content as one undo step, keeping given IDs", () => {
    const a = add("rect", { x: "1" });
    const g = add("g");
    const inner = add("circle", {}, g);
    const r = expectRoundTrip(doc, {
      op: "replace",
      tree: {
        tag: "svg",
        attrs: { viewBox: "0 0 10 10" },
        children: [
          { id: inner, tag: "circle", attrs: { r: "2" }, children: [] },
          { tag: "text", attrs: {}, children: [{ tag: TEXT_TAG, attrs: {}, text: "hi", children: [] }] },
        ],
      },
    });
    expect(r.root).toBe(doc.root);
    const tree = doc.getTree()!;
    expect(tree.attrs).toEqual({ viewBox: "0 0 10 10" });
    expect(tree.children[0]).toMatchObject({ id: inner, attrs: { r: "2" } });
    expect(doc.getNode(a)).toBeUndefined();
    expect(doc.getNode(g)).toBeUndefined();
    expect(tree.children[1]!.id).not.toBe(a);
  });

  it("validates before changing anything", () => {
    add("rect");
    expect(expectNoChange(doc, { op: "replace", tree: { tag: "g", attrs: {}, children: [] } }).code).toBe("INVALID_TAG");
    expect(expectNoChange(doc, { op: "replace", tree: { tag: "svg", attrs: {}, children: [{ id: "n_999", tag: "g", attrs: {}, children: [] }] } }).code).toBe("NOT_FOUND");
    expect(expectNoChange(doc, { op: "replace", tree: { tag: "svg", attrs: {}, children: [{ tag: TEXT_TAG, attrs: {}, text: "", children: [] }] } }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "replace", tree: { tag: "svg", attrs: { x: 1 }, children: [] } }).code).toBe("INVALID_ATTR");
  });
});
