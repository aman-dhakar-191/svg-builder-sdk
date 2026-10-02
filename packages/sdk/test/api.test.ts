import { describe, expect, it } from "vitest";
import { createEditor, SvgEditorError, type Editor } from "../src/index.js";

function expectError(fn: () => unknown, code: string): SvgEditorError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SvgEditorError);
    const err = e as SvgEditorError;
    expect(err.code).toBe(code);
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.hint.length).toBeGreaterThan(0);
    return err;
  }
  throw new Error(`expected ${code} to be thrown`);
}

const SRC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
  <!-- keep -->
  <rect x='1' y="2" width="10" height="5"/>
</svg>
`;

describe("createEditor", () => {
  it("opens text and keeps it byte-for-byte", () => {
    const ed = createEditor({ svg: SRC });
    expect(ed.text).toBe(SRC);
    expect(ed.doc.query({ tag: "rect" })).toHaveLength(1);
  });

  it("starts from an empty drawing", () => {
    const ed = createEditor();
    expect(ed.doc.getTree().tag).toBe("svg");
    expect(ed.intrinsicSize()).toEqual({ width: 400, height: 300 });
  });

  it("throws PARSE_ERROR with position for bad SVG", () => {
    const e = expectError(() => createEditor({ svg: "<svg>\n  <rect x=1/>\n</svg>" }), "PARSE_ERROR");
    expect(e.parse).toMatchObject({ line: 2, column: 11, code: "UNEXPECTED_CHAR" });
  });
});

describe("doc writes", () => {
  it("accepts numbers and formats them", () => {
    const ed = createEditor();
    const id = ed.doc.add("rect", { x: 10, y: 0.1 + 0.2, width: 100, height: 60, fill: "#4f46e5" });
    expect(ed.doc.getNode(id).attrs).toEqual({ x: "10", y: "0.3", width: "100", height: "60", fill: "#4f46e5" });
    ed.doc.set(id, { rx: 8, fill: null });
    expect(ed.doc.getNode(id).attrs).toEqual({ x: "10", y: "0.3", width: "100", height: "60", rx: "8" });
  });

  it("covers every command", () => {
    const ed = createEditor();
    const a = ed.doc.add("rect", { width: 10, height: 10 });
    const b = ed.doc.add("circle", { r: 5 });
    const g = ed.doc.group([a, b]);
    expect(ed.doc.getNode(g).children).toEqual([a, b]);
    ed.doc.move(b, g, 0);
    expect(ed.doc.getNode(g).children).toEqual([b, a]);
    expect(ed.doc.transform(a, { rotate: 90, origin: "center" })).toBe("rotate(90 5 5)");
    expect(ed.doc.transform(b, { scale: 2 })).toBe("scale(2 2)");
    expect(ed.doc.ungroup(g)).toEqual([b, a]);
    const t = ed.doc.addText("Hello", { x: 5, y: 20 });
    expect(ed.text).toContain(">Hello</text>");
    ed.doc.setText(t, "Bye");
    ed.doc.delete([a, t]);
    expect(ed.doc.query()).toEqual([ed.doc.root, b]);
  });

  it("addText is one undo step", () => {
    const ed = createEditor();
    ed.doc.addText("Hi");
    ed.undo();
    expect(ed.doc.query({ tag: "text" })).toHaveLength(0);
    expect(ed.canUndo()).toBe(false);
  });

  it("throws typed errors and leaves the document unchanged", () => {
    const ed = createEditor({ svg: SRC });
    const rect = ed.doc.query({ tag: "rect" })[0]!;
    expectError(() => ed.doc.set("n_999", { x: 1 }), "NOT_FOUND");
    expectError(() => ed.doc.add("not a tag"), "INVALID_TAG");
    expectError(() => ed.doc.add("rect", { x: Number.NaN }), "INVALID_ATTR");
    expectError(() => ed.doc.ungroup(rect), "NOT_A_GROUP");
    expectError(() => ed.doc.getNode("nope"), "NOT_FOUND");
    expect(ed.text).toBe(SRC);
  });

  it("errors serialize for tool calls", () => {
    const ed = createEditor();
    try {
      ed.doc.delete("n_42");
    } catch (e) {
      expect(JSON.parse(JSON.stringify(e))).toMatchObject({ code: "NOT_FOUND", hint: expect.any(String) });
    }
  });
});

describe("batching and history", () => {
  it("batch() is one undo step and rolls back on throw", () => {
    const ed = createEditor({ svg: SRC });
    ed.batch(() => {
      ed.doc.add("circle", { r: 1 });
      ed.doc.add("circle", { r: 2 });
    });
    expect(ed.doc.query({ tag: "circle" })).toHaveLength(2);
    ed.undo();
    expect(ed.text).toBe(SRC);

    expect(() =>
      ed.batch(() => {
        ed.doc.add("circle", { r: 1 });
        ed.doc.set("n_999", {});
      }),
    ).toThrow(SvgEditorError);
    expect(ed.text).toBe(SRC);
    expect(ed.canRedo()).toBe(true); // the rolled-back batch did not clear redo
  });

  it("beginBatch spans awaits", async () => {
    const ed = createEditor();
    const b = ed.beginBatch();
    ed.doc.add("rect");
    await Promise.resolve();
    ed.doc.add("rect");
    b.commit();
    ed.undo();
    expect(ed.doc.query({ tag: "rect" })).toHaveLength(0);
  });

  it("execute() never throws", () => {
    const ed = createEditor();
    expect(ed.execute({ op: "delete", ids: ["n_9"] })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(ed.execute({ op: "add", tag: "rect", attrs: {} })).toMatchObject({ ok: true });
  });
});

describe("text", () => {
  it("keeps formatting through commands and reports minimal edits", () => {
    const ed = createEditor({ svg: SRC });
    const events: { origin: string; edits: number }[] = [];
    ed.onChange((e) => events.push({ origin: e.origin, edits: e.edits.length }));
    ed.doc.set(ed.doc.query({ tag: "rect" })[0]!, { x: 5 });
    expect(ed.text).toBe(SRC.replace("x='1'", "x='5'"));
    expect(events).toEqual([{ origin: "model", edits: 1 }]);
  });

  it("setText keeps IDs and throws PARSE_ERROR without changing anything", () => {
    const ed = createEditor({ svg: SRC });
    const rect = ed.doc.query({ tag: "rect" })[0]!;
    ed.setText(SRC.replace('width="10"', 'width="20"'));
    expect(ed.doc.getNode(rect).attrs.width).toBe("20");
    const before = ed.text;
    const e = expectError(() => ed.setText("<svg><g></svg>"), "PARSE_ERROR");
    expect(e.parse?.code).toBe("MISMATCHED_TAG");
    expect(ed.text).toBe(before);
  });

  it("maps nodes to source ranges and back", () => {
    const ed = createEditor({ svg: SRC });
    const rect = ed.doc.query({ tag: "rect" })[0]!;
    const r = ed.getSourceRange(rect)!;
    expect(ed.text.slice(r.start, r.end)).toBe(`<rect x='1' y="2" width="10" height="5"/>`);
    expect(ed.nodeAt(r.start + 3)).toBe(rect);
  });

  it("toSvg serializes fresh", () => {
    expect(createEditor({ svg: SRC }).toSvg()).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect x="1" y="2" width="10" height="5"/></svg>');
  });
});

describe("selection", () => {
  function setup(): { ed: Editor; a: string; b: string } {
    const ed = createEditor();
    const a = ed.doc.add("rect", { x: 10, y: 10, width: 20, height: 20 });
    const b = ed.doc.add("circle", { cx: 200, cy: 200, r: 10 });
    return { ed, a, b };
  }

  it("selects, notifies and validates", () => {
    const { ed, a, b } = setup();
    const seen: string[][] = [];
    ed.onSelectionChange((ids) => seen.push(ids));
    ed.select([a, b, a]);
    expect(ed.getSelection()).toEqual([a, b]);
    ed.select(a);
    ed.select(a); // no change, no event
    expectError(() => ed.select("n_404"), "NOT_FOUND");
    ed.clearSelection();
    expect(seen).toEqual([[a, b], [a], []]);
  });

  it("drops deleted nodes from the selection, including via undo", () => {
    const { ed, a, b } = setup();
    ed.select([a, b]);
    ed.doc.delete(a);
    expect(ed.getSelection()).toEqual([b]);
    const c = ed.doc.add("rect");
    ed.select(c);
    ed.undo();
    expect(ed.getSelection()).toEqual([]);
  });

  it("selectInRect selects enclosed top-level elements in root space", () => {
    const { ed, a, b } = setup();
    expect(ed.selectInRect({ x: 0, y: 0, width: 50, height: 50 })).toEqual([a]);
    ed.doc.transform(b, { translate: [-170, -170] });
    expect(ed.selectInRect({ x: 0, y: 0, width: 50, height: 50 })).toEqual([a, b]);
  });
});

describe("geometry and bridges", () => {
  it("getBBox in local and root space", () => {
    const ed = createEditor();
    const g = ed.doc.add("g", { transform: "translate(100 0)" });
    const r = ed.doc.add("rect", { x: 1, y: 2, width: 3, height: 4, transform: "scale(2)" }, { parent: g });
    expect(ed.doc.getBBox(r)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(ed.doc.getBBox(r, "root")).toEqual({ x: 102, y: 4, width: 6, height: 8 });
    expect(ed.doc.pointToRoot(r, [1, 1])).toEqual([102, 2]);
  });

  it("text needs the measure bridge; paths are measured headlessly", () => {
    const ed = createEditor();
    expect(ed.doc.getBBox(ed.doc.add("path", { d: "M0 0L10 10", transform: "translate(5 0)" }), "root")).toEqual({ x: 5, y: 0, width: 10, height: 10 });
    const p = ed.doc.addText("Hi", { x: 0, y: 10 });
    expectError(() => ed.doc.getBBox(p, "root"), "BBOX_UNAVAILABLE");
    ed.setBridges({ measure: (id) => (id === p ? { x: 0, y: 0, width: 10, height: 10 } : null) });
    expect(ed.doc.getBBox(p, "root")).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(ed.selectInRect({ x: -1, y: -1, width: 20, height: 20 })).toContain(p);
  });

  it("exportPng uses the rasterizer bridge at the drawing's size", async () => {
    const ed = createEditor({ svg: '<svg viewBox="0 0 10 10" width="20mm"><rect width="10" height="10"/></svg>' });
    await expect(ed.exportPng()).rejects.toMatchObject({ code: "NO_RASTERIZER" });
    let got: { svg: string; size: object } | null = null;
    ed.setBridges({
      rasterize: async (svg, size) => {
        got = { svg, size };
        return new Uint8Array([137, 80, 78, 71]);
      },
    });
    expect(await ed.exportPng({ scale: 2 })).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(got!.svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(got!.size).toEqual({ width: 151, height: 151 }); // 20mm = 75.59px, x2
    ed.setBridges({ rasterize: async () => Promise.reject(new Error("boom")) });
    await expect(ed.exportPng()).rejects.toMatchObject({ code: "EXPORT_FAILED" });
  });
});

describe("exportPng options", () => {
  const capture = (ed: Editor) => {
    const calls: { svg: string; size: { width: number; height: number } }[] = [];
    ed.setBridges({
      rasterize: async (svg, size) => {
        calls.push({ svg, size });
        return new Uint8Array([1]);
      },
    });
    return calls;
  };

  it("region renders a rectangle of the drawing, even outside the page", async () => {
    const ed = createEditor({ svg: '<svg viewBox="0 0 100 50" width="200" height="100"><rect x="120" width="10" height="10"/></svg>' });
    const calls = capture(ed);
    await ed.exportPng({ region: { x: 100, y: 0, width: 50, height: 25 } });
    expect(calls[0]!.size).toEqual({ width: 100, height: 50 }); // 2 px per unit, as on the page
    expect(calls[0]!.svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="100 0 50 25" width="100" height="50" preserveAspectRatio="none">/);
    expect(ed.text).toContain('viewBox="0 0 100 50"'); // the document is untouched
  });

  it("maxSize caps the longer side; background paints under the drawing", async () => {
    const ed = createEditor({ svg: '<svg viewBox="0 0 400 200" width="400" height="200"><circle r="5"/></svg>' });
    const calls = capture(ed);
    await ed.exportPng({ scale: 4, maxSize: 800, background: "white" });
    expect(calls[0]!.size).toEqual({ width: 800, height: 400 });
    expect(calls[0]!.svg).toContain('<rect x="0" y="0" width="400" height="200" fill="white"/><circle r="5"/>');
    await ed.exportPng();
    expect(calls[1]!.svg).not.toContain("fill=\"white\"");
    expect(calls[1]!.size).toEqual({ width: 400, height: 200 });
  });

  it("longSide scales small drawings up (and large ones down)", async () => {
    const ed = createEditor({ svg: '<svg viewBox="0 0 200 120" width="200" height="120"/>' });
    const calls = capture(ed);
    await ed.exportPng({ longSide: 1000 });
    await ed.exportPng({ region: { x: 0, y: 0, width: 20, height: 10 }, longSide: 100 });
    expect(calls.map((c) => c.size)).toEqual([{ width: 1000, height: 600 }, { width: 100, height: 50 }]);
  });

  it("rejects bad regions", async () => {
    const ed = createEditor();
    capture(ed);
    await expect(ed.exportPng({ region: { x: 0, y: 0, width: 0, height: 5 } })).rejects.toMatchObject({ code: "INVALID_REGION" });
  });
});

describe("animation", () => {
  it("animates several elements with a stagger in one undo step, and reads it back", () => {
    const ed = createEditor({ svg: SRC });
    const r = ed.doc.query({ tag: "rect" })[0]!;
    const c = ed.doc.add("circle", { cx: 50, cy: 20, r: 5 });
    const before = ed.text;
    const ids = ed.doc.animate([r, c], "fadeIn", { delay: 0.2, stagger: 0.3 });
    expect(ids).toHaveLength(2);
    expect(ed.doc.getAnimations(c)).toEqual([
      { id: ids[1], tag: "animate", target: c, preset: "fadeIn", attribute: "opacity", trigger: "load", delay: 0.5, duration: 0.6, repeat: 1 },
    ]);
    expect(ed.doc.getAnimations()).toHaveLength(2);
    expect(ed.doc.timelineDuration()).toBe(1.1);
    // Minimal patch: the rect's self-closing tag opens to hold the animation, indented.
    expect(ed.text).toContain(`<rect x='1' y="2" width="10" height="5">\n    <animate attributeName="opacity"`);
    ed.undo();
    expect(ed.doc.getAnimations()).toHaveLength(0);
    ed.redo();
    expect(ed.doc.removeAnimations([r, c])).toBe(2);
    ed.undo();
    expect(ed.doc.getAnimations()).toHaveLength(2);
    ed.undo();
    expect(ed.text).toBe(before);
  });

  it("centres text motion with the measure bridge", () => {
    const ed = createEditor();
    const g = ed.doc.add("g", { transform: "translate(100 0)" });
    const t = ed.doc.addText("Hi", { x: 0, y: 10 }, { parent: g });
    expectError(() => ed.doc.animate(t, "spin"), "BBOX_UNAVAILABLE");
    ed.setBridges({ measure: (id) => (id === t ? { x: 100, y: 0, width: 20, height: 10 } : null) });
    ed.doc.animate(t, "spin");
    expect(ed.doc.getNode(ed.doc.getNode(t).children[1]!).attrs.values).toBe("0 10 5;360 10 5");
  });

  it("exports PNGs at rest; toSvg({ static }) leaves animations out", async () => {
    let seen = "";
    const ed = createEditor({ svg: SRC, rasterize: async (svg) => ((seen = svg), new Uint8Array([1])) });
    ed.doc.animate(ed.doc.query({ tag: "rect" }), "pulse");
    await ed.exportPng();
    expect(seen).toContain("<rect");
    expect(seen).not.toContain("animateTransform");
    expect(ed.toSvg()).toContain("animateTransform");
    expect(ed.toSvg({ static: true })).not.toContain("animateTransform");
  });
});

describe("paths", () => {
  const SRC2 = `<svg viewBox="0 0 100 100">
  <!-- shapes -->
  <rect id="r" x='10' y="10" width="20" height="10" fill="red"/>
  <path id="p" d="m0 0 c10 0 20 10 30 10" stroke="black"/>
</svg>
`;

  it("edits path points with a minimal patch and byte-exact undo", () => {
    const ed = createEditor({ svg: SRC2 });
    const p = ed.doc.query({ attr: { id: "p" } })[0]!;
    expect(ed.doc.getPath(p)).toEqual([{ cmd: "M", p: [0, 0] }, { cmd: "C", c1: [10, 0], c2: [20, 10], p: [30, 10] }]);
    expect(ed.doc.pathEdit(p, [{ seg: 1, point: "p", to: [30, 30] }])).toBe("M0 0 C10 0 20 30 30 30");
    expect(ed.text).toBe(SRC2.replace('d="m0 0 c10 0 20 10 30 10"', 'd="M0 0 C10 0 20 30 30 30"'));
    ed.undo();
    expect(ed.text).toBe(SRC2);
  });

  it("converts a shape to a path in place; undo restores the text exactly", () => {
    const ed = createEditor({ svg: SRC2 });
    const r = ed.doc.query({ attr: { id: "r" } })[0]!;
    const path = ed.doc.convertToPath(r);
    expect(ed.doc.getNode(path)).toMatchObject({ tag: "path", attrs: { id: "r", fill: "red", d: "M10 10 H30 V20 H10 Z" } });
    expect(ed.text).toContain("<!-- shapes -->");
    expect(ed.text).not.toContain("<rect");
    ed.undo();
    expect(ed.text).toBe(SRC2);
  });

  it("reports paths it cannot read, and non-paths", () => {
    const ed = createEditor({ svg: '<svg><path d="M0 0 L"/><circle r="1"/></svg>' });
    const [p] = ed.doc.query({ tag: "path" });
    const [c] = ed.doc.query({ tag: "circle" });
    expectError(() => ed.doc.getPath(p!), "INVALID_PATH");
    expectError(() => ed.doc.getPath(c!), "NOT_A_PATH");
  });
});

describe("translateInRoot", () => {
  it("moves nested elements by root units through scaled/rotated parents", () => {
    const ed = createEditor();
    const g = ed.doc.add("g", { transform: "scale(2) rotate(90)" });
    const r = ed.doc.add("rect", { width: 10, height: 10 }, { parent: g });
    const before = ed.doc.getBBox(r, "root");
    ed.doc.translateInRoot(r, [6, 4]);
    const after = ed.doc.getBBox(r, "root");
    expect(after.x - before.x).toBeCloseTo(6);
    expect(after.y - before.y).toBeCloseTo(4);
  });
});

describe("background", () => {
  it("sets, changes and removes a full-page background behind the drawing, each one undo step", () => {
    const ed = createEditor({ svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="5 5 100 50">\n  <defs/>\n  <rect width="10" height="5"/>\n</svg>\n` });
    expect(ed.doc.getBackground()).toBeNull();
    const id = ed.doc.setBackground("#0b1020")!;
    expect(ed.text).toContain(`<defs/>\n  <rect data-background="" x="5" y="5" width="100%" height="100%" fill="#0b1020"/>\n  <rect width="10"`);
    expect(ed.doc.getBackground()).toEqual({ id, color: "#0b1020" });
    expect(ed.doc.setBackground("white")).toBe(id);
    expect(ed.doc.getBackground()!.color).toBe("white");
    ed.doc.setBackground(null);
    expect(ed.doc.getBackground()).toBeNull();
    ed.undo();
    ed.undo();
    expect(ed.doc.getBackground()!.color).toBe("#0b1020");
    expectError(() => ed.doc.setBackground(" "), "INVALID_ATTR");
  });

  it("exports can leave it out", async () => {
    let seen = "";
    const ed = createEditor({ svg: SRC, rasterize: async (svg) => ((seen = svg), new Uint8Array([1])) });
    const id = ed.doc.setBackground("black")!;
    await ed.exportPng();
    expect(seen).toContain("data-background");
    await ed.exportPng({ omit: [id] });
    expect(seen).not.toContain("data-background");
    expect(seen).toContain("<rect x=");
    expect(ed.toSvg({ omit: [id] })).not.toContain("data-background");
  });
});

describe("keyframes", () => {
  it("sets, moves and removes single keys; reads values at any time", () => {
    const ed = createEditor({ svg: SRC });
    const r = ed.doc.query({ tag: "rect" })[0]!;
    expect(ed.doc.keyValueAt(r, "translate", 1)).toEqual([0, 0]);
    expect(ed.doc.keyValueAt(r, "opacity", 1)).toBe(1);
    ed.doc.setKeyframe(r, "translate", 0, [0, 0]);
    ed.doc.setKeyframe(r, "translate", 2, [40, 10]);
    expect(ed.doc.getKeyframes(r)).toMatchObject([{ property: "translate", keys: [{ time: 0, value: [0, 0] }, { time: 2, value: [40, 10] }] }]);
    expect(ed.doc.keyValueAt(r, "translate", 1)).toEqual([20, 5]); // eased in and out: symmetric at the middle
    ed.doc.moveKeyframe(r, "translate", 2, 1);
    expect(ed.doc.getKeyframes(r)[0]!.keys.map((k) => k.time)).toEqual([0, 1]);
    expect(ed.doc.timelineDuration()).toBe(1);
    ed.doc.removeKeyframe(r, "translate", 0);
    ed.doc.removeKeyframe(r, "translate", 1);
    expect(ed.doc.getKeyframes(r)).toEqual([]);
    expectError(() => ed.doc.moveKeyframe(r, "translate", 5, 1), "NOT_FOUND");
    // Each edit was one undo step.
    ed.undo();
    expect(ed.doc.getKeyframes(r)[0]!.keys).toHaveLength(1);
  });

  it("text rotates about its measured centre", () => {
    const ed = createEditor();
    const t = ed.doc.addText("Mizu", { x: 0, y: 10 });
    ed.setBridges({ measure: (id) => (id === t ? { x: 0, y: 0, width: 40, height: 12 } : null) });
    ed.doc.setKeyframes(t, "rotate", [{ time: 0, value: 0 }, { time: 1, value: 10 }]);
    expect(ed.doc.getNode(ed.doc.getNode(t).children[1]!).attrs.values).toBe("0 20 6;10 20 6");
  });
});
