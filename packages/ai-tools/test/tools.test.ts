import { createEditor, type Editor, type LockSession } from "@svg-editor/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { dispatch, TOOLS, validate, type ToolOutcome } from "../src/index.js";

const SRC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="400" height="200">
  <rect id="sky" width="200" height="100" fill="#e0f2fe"/>
</svg>
`;

let editor: Editor;
let session: LockSession;
const run = (name: string, input: unknown): ToolOutcome => dispatch({ doc: session.doc, editor, batch: (fn) => session.batch(fn) }, name, input);
const ok = (name: string, input: unknown = {}) => {
  const r = run(name, input);
  if (!r.ok) throw new Error(`${name} failed: ${r.error.code} ${r.error.message}`);
  return r.result as Record<string, unknown>;
};
const err = (name: string, input: unknown) => {
  const r = run(name, input);
  if (r.ok) throw new Error(`${name} unexpectedly succeeded`);
  expect(r.error.hint.length).toBeGreaterThan(0);
  return r.error;
};

beforeEach(() => {
  editor = createEditor({ svg: SRC });
  session = editor.lock({ reason: "ai" });
});

describe("tool definitions", () => {
  it("are well-formed and every one has a handler", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z_]{3,64}$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.input_schema.type).toBe("object");
      expect(JSON.parse(JSON.stringify(t.input_schema))).toEqual(t.input_schema);
      expect(run(t.name, { __probe: true })).toMatchObject({ ok: false }); // reaches validation, not "unknown tool"
      expect((run(t.name, { __probe: true }) as { error: { code: string } }).error.code).not.toBe("UNKNOWN_TOOL");
    }
  });
});

describe("validate", () => {
  const schema = TOOLS.find((t) => t.name === "add_elements")!.input_schema;
  it("accepts valid input and pinpoints invalid input", () => {
    expect(validate({ elements: [{ tag: "rect", attributes: { x: 1, fill: "red" } }] }, schema)).toBeNull();
    expect(validate({}, schema)).toBe("input.elements: required");
    expect(validate({ elements: [] }, schema)).toMatch(/at least 1/);
    expect(validate({ elements: [{ tag: 5 }] }, schema)).toBe("input.elements[0].tag: expected a string, got number 5");
    expect(validate({ elements: [{ tag: "rect", attributes: { x: [1] } }] }, schema)).toMatch(/input\.elements\[0\]\.attributes\.x: string or number expected/);
    expect(validate({ elements: [{ tag: "rect", colour: "red" }] }, schema)).toMatch(/elements\[0\]\.colour: unknown property/);
  });
});

describe("tools", () => {
  it("get_document describes size, selection and outline", () => {
    editor.select(editor.doc.query({ attr: { id: "sky" } }));
    const d = ok("get_document");
    expect(d).toMatchObject({ viewBox: "0 0 200 100", size: { width: 400, height: 200 }, element_count: 1 });
    expect(d.selection).toHaveLength(1);
    expect(d.outline).toEqual([{ id: expect.any(String), tag: "rect", attributes: { id: "sky", width: "200", height: "100", fill: "#e0f2fe" } }]);
  });

  it("add_elements builds nested content with $N parents, all or nothing", () => {
    const r = ok("add_elements", {
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
    const e = err("add_elements", { elements: [{ tag: "circle", attributes: { r: 3 } }, { tag: "rect", parent: "n_999" }] });
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toMatch(/^elements\[1\] \(<rect>\):.*Nothing was added\./);
    expect(editor.text).toBe(before);
    expect(err("add_elements", { elements: [{ tag: "rect", parent: "$0" }] }).code).toBe("INVALID_COMMAND");
  });

  it("query, get_element, set, transform, text, move, group, ungroup, delete", () => {
    const [a, b] = ok("add_elements", { elements: [{ tag: "circle", attributes: { cx: 20, cy: 20, r: 5, fill: "red" } }, { tag: "rect", attributes: { x: 40, y: 10, width: 10, height: 10, fill: "red" } }] }).ids as string[];
    expect(ok("query_elements", { attributes: { fill: "red" } }).count).toBe(2);
    expect(ok("query_elements", { tag: "circle" }).elements).toEqual([{ id: a, tag: "circle", attributes: { cx: "20", cy: "20", r: "5", fill: "red" } }]);
    expect(ok("get_element", { id: a })).toMatchObject({ tag: "circle", bbox: { x: 15, y: 15, width: 10, height: 10 } });
    expect(ok("set_attributes", { id: a, attributes: { fill: "blue", r: null } }).attributes).toEqual({ cx: "20", cy: "20", fill: "blue" });
    expect(ok("transform_element", { id: b!, rotate: 90, origin: "center" }).transform).toBe("rotate(90 45 15)");
    const { id: g } = ok("group_elements", { ids: [a, b] }) as { id: string };
    expect(ok("ungroup_element", { id: g }).ids).toEqual([a, b]);
    ok("move_element", { id: a!, parent: editor.doc.root, index: 0 });
    expect(editor.doc.getNode(editor.doc.root).children[0]).toBe(a);
    ok("delete_elements", { ids: [a, b] });
    expect(editor.doc.query({ tag: "circle" })).toEqual([]);
  });

  it("align and distribute in drawing coordinates", () => {
    const ids = ok("add_elements", {
      elements: [
        { tag: "rect", attributes: { x: 10, y: 5, width: 10, height: 10 } },
        { tag: "rect", attributes: { x: 30, y: 25, width: 10, height: 10 } },
        { tag: "rect", attributes: { x: 90, y: 15, width: 10, height: 10 } },
      ],
    }).ids as string[];
    ok("align_elements", { ids, edge: "top" });
    expect(ids.map((i) => editor.doc.getBBox(i, "root").y)).toEqual([5, 5, 5]);
    ok("distribute_elements", { ids, axis: "horizontal" });
    const xs = ids.map((i) => editor.doc.getBBox(i, "root").x);
    expect(xs[1]! - xs[0]!).toBeCloseTo(xs[2]! - xs[1]!);
    expect(err("align_elements", { ids: [ids[0]], edge: "top" }).code).toBe("INVALID_INPUT");
  });

  it("select_elements shows the user what changed", () => {
    const [a] = ok("add_elements", { elements: [{ tag: "circle", attributes: { r: 4 } }] }).ids as string[];
    expect(ok("select_elements", { ids: [a] }).selection).toEqual([a]);
  });

  it("reports unknown tools, bad input and SDK errors with code, message and hint", () => {
    expect(err("paint", {}).code).toBe("UNKNOWN_TOOL");
    expect(err("set_attributes", { id: "n_1" }).code).toBe("INVALID_INPUT");
    expect(err("set_attributes", { id: "n_404", attributes: { x: 1 } }).code).toBe("NOT_FOUND");
    expect(err("ungroup_element", { id: editor.doc.query({ attr: { id: "sky" } })[0] }).code).toBe("NOT_A_GROUP");
  });
});

describe("acceptance: a house with a red door, as one undo step", () => {
  it("draws through the lock session and undoes in one step", () => {
    ok("get_document");
    ok("add_elements", {
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
