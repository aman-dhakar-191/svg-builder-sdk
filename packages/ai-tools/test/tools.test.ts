import { createEditor, type Editor, type LockSession } from "@svg-editor/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { dispatch, TOOLS, toolsFor, validate, type ToolOutcome } from "../src/index.js";

const SRC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="400" height="200">
  <rect id="sky" width="200" height="100" fill="#e0f2fe"/>
</svg>
`;

let editor: Editor;
let session: LockSession;
const run = (name: string, input: unknown): Promise<ToolOutcome> => dispatch({ doc: session.doc, editor, batch: (fn) => session.batch(fn) }, name, input);
const ok = async (name: string, input: unknown = {}) => {
  const r = await run(name, input);
  if (!r.ok) throw new Error(`${name} failed: ${r.error.code} ${r.error.message}`);
  return r.result as Record<string, unknown>;
};
const err = async (name: string, input: unknown) => {
  const r = await run(name, input);
  if (r.ok) throw new Error(`${name} unexpectedly succeeded`);
  expect(r.error.hint.length).toBeGreaterThan(0);
  return r.error;
};

beforeEach(() => {
  editor = createEditor({ svg: SRC });
  session = editor.lock({ reason: "ai" });
});

describe("tool definitions", () => {
  it("are well-formed and every one has a handler", async () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z_]{3,64}$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.input_schema.type).toBe("object");
      expect(JSON.parse(JSON.stringify(t.input_schema))).toEqual(t.input_schema);
      expect(await run(t.name, { __probe: true })).toMatchObject({ ok: false }); // reaches validation, not "unknown tool"
      expect((await run(t.name, { __probe: true }) as { error: { code: string } }).error.code).not.toBe("UNKNOWN_TOOL");
    }
  });
});

describe("validate", () => {
  const schema = TOOLS.find((t) => t.name === "add_elements")!.input_schema;
  it("accepts valid input and pinpoints invalid input", async () => {
    expect(validate({ elements: [{ tag: "rect", attributes: { x: 1, fill: "red" } }] }, schema)).toBeNull();
    expect(validate({}, schema)).toBe("input.elements: required");
    expect(validate({ elements: [] }, schema)).toMatch(/at least 1/);
    expect(validate({ elements: [{ tag: 5 }] }, schema)).toBe("input.elements[0].tag: expected a string, got number 5");
    expect(validate({ elements: [{ tag: "rect", attributes: { x: [1] } }] }, schema)).toMatch(/input\.elements\[0\]\.attributes\.x: string or number expected/);
    expect(validate({ elements: [{ tag: "rect", colour: "red" }] }, schema)).toMatch(/elements\[0\]\.colour: unknown property/);
  });
});

describe("tools", () => {
  it("get_document describes size, selection and outline", async () => {
    editor.select(editor.doc.query({ attr: { id: "sky" } }));
    const d = await ok("get_document");
    expect(d).toMatchObject({ viewBox: "0 0 200 100", size: { width: 400, height: 200 }, element_count: 1 });
    expect(d.selection).toHaveLength(1);
    expect(d.outline).toEqual([{ id: expect.any(String), tag: "rect", attributes: { id: "sky", width: "200", height: "100", fill: "#e0f2fe" } }]);
  });

  it("add_elements builds nested content with $N parents, all or nothing", async () => {
    const r = await ok("add_elements", {
      elements: [
        { tag: "g", attributes: { id: "house" } },
        { tag: "rect", attributes: { x: 60, y: 50, width: 80, height: 50, fill: "#fde68a" }, parent: "$0" },
        { tag: "text", attributes: { x: 5, y: 95 }, text: "Home" },
      ],
    });
    const [g, wall, label] = r.ids as string[];
    expect(editor.doc.getNode(wall!).parent).toBe(g);
    expect(editor.text).toContain(">Home</text>");
    expect(label).toBeDefined();

    const before = editor.text;
    const e = await err("add_elements", { elements: [{ tag: "circle", attributes: { r: 3 } }, { tag: "rect", parent: "n_999" }] });
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toMatch(/^elements\[1\] \(<rect>\):.*Nothing was added\./);
    expect(editor.text).toBe(before);
    expect((await err("add_elements", { elements: [{ tag: "rect", parent: "$0" }] })).code).toBe("INVALID_COMMAND");
  });

  it("query, get_element, set, transform, text, move, group, ungroup, delete", async () => {
    const [a, b] = (await ok("add_elements", { elements: [{ tag: "circle", attributes: { cx: 20, cy: 20, r: 5, fill: "red" } }, { tag: "rect", attributes: { x: 40, y: 10, width: 10, height: 10, fill: "red" } }] })).ids as string[];
    expect((await ok("query_elements", { attributes: { fill: "red" } })).count).toBe(2);
    expect((await ok("query_elements", { tag: "circle" })).elements).toEqual([{ id: a, tag: "circle", attributes: { cx: "20", cy: "20", r: "5", fill: "red" } }]);
    expect(await ok("get_element", { id: a })).toMatchObject({ tag: "circle", bbox: { x: 15, y: 15, width: 10, height: 10 } });
    expect((await ok("set_attributes", { id: a, attributes: { fill: "blue", r: null } })).attributes).toEqual({ cx: "20", cy: "20", fill: "blue" });
    expect((await ok("transform_element", { id: b!, rotate: 90, origin: "center" })).transform).toBe("rotate(90 45 15)");
    const { id: g } = await ok("group_elements", { ids: [a, b] }) as { id: string };
    expect((await ok("ungroup_element", { id: g })).ids).toEqual([a, b]);
    await ok("move_element", { id: a!, parent: editor.doc.root, index: 0 });
    expect(editor.doc.getNode(editor.doc.root).children[0]).toBe(a);
    await ok("delete_elements", { ids: [a, b] });
    expect(editor.doc.query({ tag: "circle" })).toEqual([]);
  });

  it("align and distribute in drawing coordinates", async () => {
    const ids = (await ok("add_elements", {
      elements: [
        { tag: "rect", attributes: { x: 10, y: 5, width: 10, height: 10 } },
        { tag: "rect", attributes: { x: 30, y: 25, width: 10, height: 10 } },
        { tag: "rect", attributes: { x: 90, y: 15, width: 10, height: 10 } },
      ],
    })).ids as string[];
    await ok("align_elements", { ids, edge: "top" });
    expect(ids.map((i) => editor.doc.getBBox(i, "root").y)).toEqual([5, 5, 5]);
    await ok("distribute_elements", { ids, axis: "horizontal" });
    const xs = ids.map((i) => editor.doc.getBBox(i, "root").x);
    expect(xs[1]! - xs[0]!).toBeCloseTo(xs[2]! - xs[1]!);
    expect((await err("align_elements", { ids: [ids[0]], edge: "top" })).code).toBe("INVALID_INPUT");
  });

  it("select_elements shows the user what changed", async () => {
    const [a] = (await ok("add_elements", { elements: [{ tag: "circle", attributes: { r: 4 } }] })).ids as string[];
    expect((await ok("select_elements", { ids: [a] })).selection).toEqual([a]);
  });

  it("reports unknown tools, bad input and SDK errors with code, message and hint", async () => {
    expect((await err("paint", {})).code).toBe("UNKNOWN_TOOL");
    expect((await err("set_attributes", { id: "n_1" })).code).toBe("INVALID_INPUT");
    expect((await err("set_attributes", { id: "n_404", attributes: { x: 1 } })).code).toBe("NOT_FOUND");
    expect((await err("ungroup_element", { id: editor.doc.query({ attr: { id: "sky" } })[0] })).code).toBe("NOT_A_GROUP");
  });
});

describe("acceptance: a house with a red door, as one undo step", () => {
  it("draws through the lock session and undoes in one step", async () => {
    await ok("get_document");
    await ok("add_elements", {
      elements: [
        { tag: "g", attributes: { id: "house" } },
        { tag: "rect", parent: "$0", attributes: { x: 60, y: 50, width: 80, height: 45, fill: "#fde68a", stroke: "#78350f" } },
        { tag: "polygon", parent: "$0", attributes: { points: "55,50 100,20 145,50", fill: "#b91c1c" } },
        { tag: "rect", parent: "$0", attributes: { id: "door", x: 92, y: 70, width: 16, height: 25, fill: "#dc2626" } },
      ],
    });
    session.commit();
    const door = editor.doc.query({ attr: { id: "door" } })[0]!;
    expect(editor.doc.getNode(door).attrs.fill).toBe("#dc2626");
    expect(createEditor({ svg: editor.text }).doc.query({ tag: "polygon" })).toHaveLength(1); // valid SVG
    editor.undo();
    expect(editor.text).toBe(SRC);
  });
});

describe("render_snapshot", () => {
  /** A fake rasterizer: a PNG header with the requested size, and the SVG it was given. */
  const rasterized: string[] = [];
  const fakePng = (w: number, h: number) => {
    const b = new Uint8Array(24);
    b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const v = new DataView(b.buffer);
    v.setUint32(16, w);
    v.setUint32(20, h);
    return b;
  };
  beforeEach(() => {
    rasterized.length = 0;
    editor.setBridges({
      rasterize: async (svg, size) => {
        rasterized.push(svg);
        return fakePng(size.width, size.height);
      },
    });
  });

  it("returns a PNG of the page, scaled to 1024 px on the long side, on white", async () => {
    const r = await run("render_snapshot", {});
    if (!r.ok) throw new Error(r.error.message);
    expect(r.result).toMatchObject({ width: 1024, height: 512, region: "whole page" });
    expect(r.image!.mediaType).toBe("image/png");
    expect(r.image!.data).toBe(Buffer.from(fakePng(1024, 512)).toString("base64"));
    expect(rasterized[0]).toContain('fill="white"');
  });

  it("frames elements by id, and sees uncommitted work of the turn", async () => {
    const [a] = (await ok("add_elements", { elements: [{ tag: "rect", attributes: { x: 150, y: 40, width: 20, height: 10, fill: "red" } }] })).ids as string[];
    const r = await ok("render_snapshot", { ids: [a], padding: 5 });
    expect(r.region).toEqual({ x: 145, y: 35, width: 30, height: 20 });
    expect(rasterized[0]).toContain('viewBox="145 35 30 20"');
    expect(rasterized[0]).toContain('fill="red"');
  });

  it("stops at the per-turn budget and needs image-capable models", async () => {
    const budget = { left: 1 };
    const target = { doc: session.doc, editor, batch: <T,>(fn: () => T) => session.batch(fn), snapshotBudget: budget };
    expect((await dispatch(target, "render_snapshot", {})).ok).toBe(true);
    expect(await dispatch(target, "render_snapshot", {})).toMatchObject({ ok: false, error: { code: "SNAPSHOT_LIMIT" } });
    expect(toolsFor({ vision: false }).map((t) => t.name)).not.toContain("render_snapshot");
    expect(toolsFor({ vision: true }).map((t) => t.name)).toContain("render_snapshot");
  });

  it("reports a missing rasterizer as a tool error", async () => {
    editor.setBridges({ rasterize: undefined as never });
    expect(await err("render_snapshot", {})).toMatchObject({ code: "NO_RASTERIZER" });
  });
});

describe("path tools", () => {
  it("convert_to_path, get_element segments, edit_path; all undoable", async () => {
    const [r] = (await ok("add_elements", { elements: [{ tag: "rect", attributes: { x: 10, y: 10, width: 20, height: 10, fill: "red" } }] })).ids as string[];
    const [p] = (await ok("convert_to_path", { ids: [r] })).ids as string[];
    const el = await ok("get_element", { id: p });
    expect(el.segments).toEqual([
      { cmd: "M", p: [10, 10] },
      { cmd: "L", p: [30, 10] },
      { cmd: "L", p: [30, 20] },
      { cmd: "L", p: [10, 20] },
      { cmd: "Z" },
    ]);
    expect((await ok("edit_path", { id: p, moves: [{ seg: 2, point: "p", to: [40, 30] }] })).d).toBe("M10 10 L30 10 L40 30 L10 20 Z");
    expect((await err("edit_path", { id: p, moves: [{ seg: 1, point: "c1", to: [0, 0] }] })).code).toBe("INVALID_COMMAND");
    expect((await ok("edit_path_nodes", { id: p, action: "insert", seg: 1, t: 0.5 })).d).toBe("M10 10 L20 10 L30 10 L40 30 L10 20 Z");
    expect((await ok("edit_path_nodes", { id: p, action: "delete", seg: 1 })).d).toBe("M10 10 L30 10 L40 30 L10 20 Z");
    expect((await ok("edit_path_nodes", { id: p, action: "segment", seg: 1, type: "curve" })).d).toMatch(/^M10 10 C/);
    expect((await err("edit_path_nodes", { id: p, action: "node", seg: 1, type: "line" })).code).toBe("INVALID_COMMAND");
    expect((await err("convert_to_path", { ids: [editor.doc.query({ attr: { id: "sky" } })[0], "n_404"] })).code).toBe("NOT_FOUND");
    session.commit();
    editor.undo();
    expect(editor.text).toBe(SRC);
  });
});

describe("combine and simplify tools", () => {
  it("makes a crescent from two circles; errors are explained; undoable", async () => {
    const [a, b] = (await ok("add_elements", { elements: [{ tag: "circle", attributes: { cx: 100, cy: 50, r: 30, fill: "gold" } }, { tag: "circle", attributes: { cx: 115, cy: 42, r: 26 } }] })).ids as string[];
    const r = await ok("combine_shapes", { operation: "subtract", ids: [b, a] });
    const node = editor.doc.getNode(r.id as string);
    expect(node).toMatchObject({ tag: "path", attrs: { fill: "gold" } });
    expect(editor.doc.query({ tag: "circle" })).toEqual([]);
    const s = await ok("simplify_path", { id: r.id, tolerance: 2 });
    expect(s.nodes).toMatchObject({ before: expect.any(Number), after: expect.any(Number) });
    const [c] = (await ok("add_elements", { elements: [{ tag: "circle", attributes: { cx: 0, cy: 0, r: 1 } }] })).ids as string[];
    expect((await err("combine_shapes", { operation: "intersect", ids: [r.id, c] })).code).toBe("EMPTY_RESULT");
    session.commit();
    editor.undo();
    expect(editor.text).toBe(SRC);
  });
});

describe("animation tools", () => {
  it("animate_elements staggers a sequence, get_document lists it, remove_animations takes it off; undoable", async () => {
    const [a, b] = (await ok("add_elements", { elements: [{ tag: "circle", attributes: { cx: 50, cy: 50, r: 10 } }, { tag: "path", attributes: { d: "M100 50 L150 50", stroke: "black" } }] })).ids as string[];
    const r = await ok("animate_elements", { ids: [a, b], preset: "popIn", stagger: 0.25 });
    expect(r).toEqual({ animated: [a, b], preset: "popIn", animation_elements: 6, animation_seconds: 0.75 });
    await ok("animate_elements", { ids: [b], preset: "drawOn", trigger: "click" });
    const d = await ok("get_document");
    expect(d.animation_seconds).toBe(0.75);
    expect((d.outline as { id: string; motion?: string[]; children?: unknown }[]).find((n) => n.id === b)).toMatchObject({ motion: ["popIn", "drawOn"] });
    expect((d.outline as { id: string; children?: unknown }[]).find((n) => n.id === b)!.children).toBeUndefined();

    expect((await err("animate_elements", { ids: [a], preset: "drawOn" })).code).toBe("NOT_ANIMATABLE");
    expect((await err("animate_elements", { ids: [a], preset: "bounce" })).code).toBe("INVALID_INPUT");
    expect(await ok("remove_animations", { ids: [b], preset: "drawOn" })).toEqual({ removed: 3 }); // dash, offset, and the default black fill fading in
    expect(await ok("remove_animations", { ids: [a, b] })).toEqual({ removed: 6 });
    session.commit();
    editor.undo();
    expect(editor.text).toBe(SRC);
  });

  it("lists the same presets as the model", async () => {
    const { MOTION_PRESETS } = await import("@svg-editor/sdk");
    const tool = TOOLS.find((t) => t.name === "animate_elements")!;
    expect((tool.input_schema.properties as Record<string, { enum?: string[] }>).preset!.enum).toEqual([...MOTION_PRESETS]);
  });
});

describe("background tool", () => {
  it("set_background sets, reports and removes the page background; undoable", async () => {
    expect((await ok("set_background", { color: "#0b1020" })).background).toBe("#0b1020");
    expect((await ok("get_document")).background).toBe("#0b1020");
    expect(editor.doc.topLevel().some((id) => "data-background" in editor.doc.getNode(id).attrs)).toBe(false);
    expect((await ok("set_background", { color: null })).background).toBeNull();
    expect((await ok("get_document")).background).toBeNull();
    expect((await err("set_background", {})).code).toBe("INVALID_INPUT");
    session.commit();
    editor.undo();
    expect(editor.text).toBe(SRC);
  });
});

describe("keyframe tool", () => {
  it("set_keyframes moves and recolours over time; get_document lists the tracks; undoable", async () => {
    const [a] = (await ok("add_elements", { elements: [{ tag: "circle", attributes: { cx: 20, cy: 50, r: 10, fill: "red" } }] })).ids as string[];
    expect(await ok("set_keyframes", { id: a, property: "translate", keys: [{ time: 0, value: [0, 0] }, { time: 2, value: [150, 0] }] })).toMatchObject({ keys: 2, animation_seconds: 2 });
    await ok("set_keyframes", { id: a, property: "fill", keys: [{ time: 0, value: "red" }, { time: 2, value: "blue" }], easing: "linear" });
    const d = await ok("get_document");
    expect((d.outline as { id: string; motion?: string[] }[]).find((n) => n.id === a)!.motion).toEqual(["keys:translate", "keys:fill"]);
    expect((await err("set_keyframes", { id: a, property: "opacity", keys: [{ time: 0, value: 3 }] })).code).toBe("INVALID_COMMAND");
    expect(await ok("remove_animations", { ids: [a], preset: "keys" })).toEqual({ removed: 2 });
    session.commit();
    editor.undo();
    expect(editor.text).toBe(SRC);
  });
});

describe("working with the model's own ids, and the page size", () => {
  it("parent and ids may be the id attribute the model gave an element", async () => {
    await ok("add_elements", { elements: [{ tag: "defs", attributes: { id: "logo_defs" } }, { tag: "g", attributes: { id: "mark" } }] });
    const r = await ok("add_elements", { elements: [{ tag: "linearGradient", parent: "logo_defs", attributes: { id: "grad" } }, { tag: "circle", parent: "#mark", attributes: { r: 5 } }] });
    const [grad, circle] = r.ids as string[];
    expect(editor.doc.getNode(editor.doc.getNode(grad!).parent!).attrs.id).toBe("logo_defs");
    expect(editor.doc.getNode(editor.doc.getNode(circle!).parent!).attrs.id).toBe("mark");
    await ok("set_attributes", { id: "mark", attributes: { opacity: 0.5 } });
    expect(editor.doc.query({ attr: { id: "mark", opacity: "0.5" } })).toHaveLength(1);
    await ok("delete_elements", { ids: ["#mark"] });
    expect(editor.doc.query({ attr: { id: "mark" } })).toHaveLength(0);
    // Unknown names still fail with the usual error.
    expect((await err("set_attributes", { id: "nope", attributes: { x: 1 } })).code).toBe("NOT_FOUND");
  });

  it("set_canvas resizes the page; get_document names the root", async () => {
    expect(await ok("set_canvas", { width: 1200, height: 800 })).toEqual({ width: 1200, height: 800, viewBox: "0 0 1200 800" });
    const d = await ok("get_document");
    expect(d).toMatchObject({ root: editor.doc.root, viewBox: "0 0 1200 800", size: { width: 1200, height: 800 } });
    expect((await err("set_canvas", { width: 2, height: 800 })).code).toBe("INVALID_INPUT");
  });
});
