import { describe, expect, it } from "vitest";
import { find, ok, open } from "./helpers.js";

const SRC = `<svg xmlns="http://www.w3.org/2000/svg">
  <!-- note -->
  <rect id="r" x="1"/>
  <circle r="2"/>
</svg>`;

describe("setText (code pane edits)", () => {
  it("updates the model, keeps IDs, and is one undo step", () => {
    const s = open(SRC);
    const rect = find(s, "rect");
    const circle = find(s, "circle");
    const edited = SRC.replace('x="1"', 'x="5"').replace("<circle", '<line x2="3"/>\n  <circle');
    const r = s.setText(edited);
    expect(r).toMatchObject({ ok: true, created: 1 });
    expect(s.text).toBe(edited);
    expect(s.doc.getNode(rect)!.attrs.x).toBe("5");
    expect(s.doc.getNode(circle)).toBeDefined();
    expect(s.doc.query({ tag: "line" })).toHaveLength(1);
    expect(s.changes.at(-1)!.method).toBe("code");

    s.doc.undo();
    expect(s.text).toBe(SRC);
    expect(s.doc.getNode(rect)!.attrs.x).toBe("1");
    expect(s.doc.query({ tag: "line" })).toHaveLength(0);
    s.doc.redo();
    expect(s.text).toBe(edited);
    expect(s.fallbacks).toBe(0);
  });

  it("keeps the last good model on a parse error", () => {
    const s = open(SRC);
    const before = s.doc.getTree();
    const r = s.setText(SRC.replace("<circle", "<circle <"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: "UNEXPECTED_CHAR", line: 4 });
    expect(s.doc.getTree()).toEqual(before);
    expect(s.text).toBe(SRC);
    expect(s.doc.canUndo()).toBe(false);
  });

  it("mixes with model commands and undoes back to the original bytes", () => {
    const s = open(SRC);
    const texts = [s.text];
    s.setText(SRC.replace('x="1"', 'x="9"'));
    texts.push(s.text);
    ok(s.doc.execute({ op: "set", id: find(s, "circle"), attrs: { fill: "red" } }));
    texts.push(s.text);
    s.setText(s.text.replace("<!-- note -->", "<!-- edited note -->\n  <g/>"));
    texts.push(s.text);
    ok(s.doc.execute({ op: "move", id: find(s, "circle"), parent: find(s, "g"), index: 0 }));
    texts.push(s.text);
    expect(s.text).toContain("<!-- edited note -->");
    for (let i = texts.length - 2; i >= 0; i--) {
      s.doc.undo();
      expect(s.text).toBe(texts[i]);
    }
    for (let i = 1; i < texts.length; i++) {
      s.doc.redo();
      expect(s.text).toBe(texts[i]);
    }
    expect(s.fallbacks).toBe(0);
  });

  it("a no-op edit records nothing", () => {
    const s = open(SRC);
    expect(s.setText(SRC)).toMatchObject({ ok: true });
    expect(s.doc.canUndo()).toBe(false);
  });
});

describe("nodeAt", () => {
  it("finds the deepest element at an offset", () => {
    const s = open(`<svg>\n  <g>\n    <rect/>\n  </g>\n</svg>`);
    const at = (needle: string) => s.nodeAt(s.text.indexOf(needle));
    expect(at("<rect")).toBe(find(s, "rect"));
    expect(at("<g>")).toBe(find(s, "g"));
    expect(at("\n    <rect")).toBe(find(s, "g"));
    expect(at("<svg")).toBe(s.doc.root);
  });
});
