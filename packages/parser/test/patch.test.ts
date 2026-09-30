import { describe, expect, it } from "vitest";
import { expectCleanUndo, find, ok, open } from "./helpers.js";

const SRC = `<svg xmlns="http://www.w3.org/2000/svg">
  <!-- keep me -->
  <g id="a"   transform = "translate(1,2)">
    <rect x='1' y="2" fill="red"/>
    <circle r="3"/>
  </g>
  <text x="0">Hi &amp; bye</text>
</svg>
`;

describe("set", () => {
  it("replaces only the value, keeping the quote style", () => {
    const s = open(SRC);
    ok(s.doc.execute({ op: "set", id: find(s, "rect"), attrs: { x: "5" } }));
    expect(s.text).toBe(SRC.replace("x='1'", "x='5'"));
    expect(s.changes[0]!.edits).toHaveLength(1);
    expect(s.changes[0]!.method).toBe("patch");
    expectCleanUndo(s, SRC);
  });

  it("appends new attributes after their model predecessor and removes with leading space", () => {
    const s = open(SRC);
    const rect = find(s, "rect");
    ok(s.doc.execute({ op: "set", id: rect, attrs: { y: null, stroke: "blue" } }));
    expect(s.text).toBe(SRC.replace(`<rect x='1' y="2" fill="red"/>`, `<rect x='1' fill="red" stroke="blue"/>`));
    expectCleanUndo(s, SRC);
  });

  it("escapes values for the attribute's quote", () => {
    const s = open(SRC);
    ok(s.doc.execute({ op: "set", id: find(s, "rect"), attrs: { x: `it's "q" & <` } }));
    expect(s.text).toContain(`x='it&apos;s "q" &amp; &lt;'`);
    expect(s.doc.getNode(find(s, "rect"))!.attrs.x).toBe(`it's "q" & <`);
  });
});

describe("add", () => {
  it("inserts on its own line with the sibling's indentation", () => {
    const s = open(SRC);
    ok(s.doc.execute({ op: "add", parent: find(s, "g"), index: 1, tag: "line", attrs: { x2: "9" } }));
    expect(s.text).toBe(SRC.replace(`<rect x='1' y="2" fill="red"/>\n`, `<rect x='1' y="2" fill="red"/>\n    <line x2="9"/>\n`));
    expectCleanUndo(s, SRC);
  });

  it("inserts before the first child", () => {
    const s = open(SRC);
    ok(s.doc.execute({ op: "add", parent: find(s, "g"), index: 0, tag: "line", attrs: {} }));
    expect(s.text).toContain(`transform = "translate(1,2)">\n    <line/>\n    <rect`);
    expectCleanUndo(s, SRC);
  });

  it("opens a self-closing parent and indents a nested subtree", () => {
    const s = open(`<svg>\n  <g/>\n</svg>`);
    const g = find(s, "g");
    ok(s.doc.execute({ op: "add", parent: g, tag: "g", attrs: { id: "inner" } }));
    ok(s.doc.execute({ op: "add", parent: find(s, "g", { id: "inner" }), tag: "rect", attrs: {} }));
    expect(s.text).toBe(`<svg>\n  <g>\n    <g id="inner">\n      <rect/>\n    </g>\n  </g>\n</svg>`);
    expectCleanUndo(s, `<svg>\n  <g/>\n</svg>`);
  });
});

describe("delete", () => {
  it("removes the element's whole line and leaves comments alone", () => {
    const s = open(SRC);
    ok(s.doc.execute({ op: "delete", ids: [find(s, "circle")] }));
    expect(s.text).toBe(SRC.replace(`\n    <circle r="3"/>`, ""));
    expectCleanUndo(s, SRC);
  });

  it("undo of a deleted subtree restores its original bytes", () => {
    const s = open(SRC);
    ok(s.doc.execute({ op: "delete", ids: [find(s, "g")] }));
    expect(s.text).not.toContain("<rect");
    expect(s.text).toContain("<!-- keep me -->");
    expectCleanUndo(s, SRC);
  });

  it("removes inline siblings without touching their neighbours", () => {
    const src = `<svg><a/> <b/> <c/></svg>`;
    const s = open(src);
    ok(s.doc.execute({ op: "delete", ids: [find(s, "b")] }));
    expect(s.text).toBe(`<svg><a/> <c/></svg>`);
    expectCleanUndo(s, src);
  });
});

describe("move", () => {
  it("moves the exact bytes of an element", () => {
    const s = open(SRC);
    ok(s.doc.execute({ op: "move", id: find(s, "circle"), parent: find(s, "g"), index: 0 }));
    expect(s.text).toBe(SRC.replace(`<rect x='1' y="2" fill="red"/>\n    <circle r="3"/>`, `<circle r="3"/>\n    <rect x='1' y="2" fill="red"/>`));
    expectCleanUndo(s, SRC);
  });

  it("reparents to another level", () => {
    const s = open(SRC);
    ok(s.doc.execute({ op: "move", id: find(s, "rect"), parent: s.doc.root, index: 2 }));
    expect(s.text).toContain(`</text>\n  <rect x='1' y="2" fill="red"/>\n</svg>`);
    expect(s.changes[0]!.method).toBe("patch");
    expectCleanUndo(s, SRC);
  });
});

describe("setText", () => {
  it("rewrites only the text", () => {
    const s = open(SRC);
    ok(s.doc.execute({ op: "setText", id: find(s, "text"), text: "<new> & improved" }));
    expect(s.text).toBe(SRC.replace("Hi &amp; bye", "&lt;new&gt; &amp; improved"));
    expectCleanUndo(s, SRC);
  });

  it("adds text to an empty element without formatting whitespace", () => {
    const src = `<svg>\n  <text/>\n  <title></title>\n</svg>`;
    const s = open(src);
    ok(s.doc.execute({ op: "setText", id: find(s, "text"), text: "a" }));
    ok(s.doc.execute({ op: "setText", id: find(s, "title"), text: "b" }));
    expect(s.text).toBe(`<svg>\n  <text>a</text>\n  <title>b</title>\n</svg>`);
    expectCleanUndo(s, src);
  });
});

describe("group / ungroup / transform / batch", () => {
  it("group and ungroup stay minimal patches and undo byte-exactly", () => {
    const s = open(SRC);
    const [rect, circle] = [find(s, "rect"), find(s, "circle")];
    const { id: g } = ok(s.doc.execute({ op: "group", ids: [rect, circle] }));
    expect(s.text).toContain(`<g>\n      <rect x='1' y="2" fill="red"/>\n      <circle r="3"/>\n    </g>`);
    ok(s.doc.execute({ op: "ungroup", id: g }));
    ok(s.doc.execute({ op: "set", id: find(s, "g", { id: "a" }), attrs: { id: null } }));
    ok(s.doc.execute({ op: "ungroup", id: find(s, "g") }));
    expect(s.text).toContain(`<rect x='1' y="2" fill="red" transform="translate(1,2)"/>`);
    expectCleanUndo(s, SRC);
  });

  it("transform patches the transform value in place", () => {
    const s = open(SRC);
    ok(s.doc.execute({ op: "transform", id: find(s, "g"), translate: [4, 3] }));
    expect(s.text).toBe(SRC.replace(`transform = "translate(1,2)"`, `transform = "translate(5 5)"`));
    expectCleanUndo(s, SRC);
  });

  it("a failed batch leaves the text byte-identical", () => {
    const s = open(SRC);
    const r = s.doc.execute({
      op: "batch",
      commands: [
        { op: "delete", ids: [find(s, "rect")] },
        { op: "set", id: find(s, "circle"), attrs: { r: "9" } },
        { op: "delete", ids: ["n_999"] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(s.text).toBe(SRC);
    expect(s.fallbacks).toBe(0);
  });
});

describe("CRLF documents", () => {
  it("uses the document's line endings for inserted lines and text", () => {
    const src = "<svg>\r\n\t<g>\r\n\t\t<a/>\r\n\t</g>\r\n\t<text>x</text>\r\n</svg>\r\n";
    const s = open(src);
    ok(s.doc.execute({ op: "add", parent: find(s, "g"), tag: "b", attrs: {} }));
    ok(s.doc.execute({ op: "setText", id: find(s, "text"), text: "1\n2" }));
    expect(s.text).toBe("<svg>\r\n\t<g>\r\n\t\t<a/>\r\n\t\t<b/>\r\n\t</g>\r\n\t<text>1\r\n2</text>\r\n</svg>\r\n");
    expectCleanUndo(s, src);
  });
});
