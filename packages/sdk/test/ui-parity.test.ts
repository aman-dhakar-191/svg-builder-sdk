/**
 * Phase 1 exit test: everything the desktop UI can do to a document is doable
 * through the SDK. Three checks:
 *   1. The UI cannot bypass the SDK: its runtime imports come only from @svg-editor/sdk.
 *   2. Every UI action has an SDK equivalent, executed here headlessly.
 *   3. Every menu action and canvas tool in the app's source is listed below,
 *      either with its SDK equivalent or as view-only. Adding a UI action
 *      without deciding which is a test failure.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEditor, SvgEditorError, type Editor } from "../src/index.js";

const app = new URL("../../../apps/desktop/src/", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, app), "utf8");

const SRC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <!-- scene -->
  <rect id="a" x="10" y="10" width="20" height="20"/>
  <circle id="b" cx="80" cy="20" r="10"/>
  <g id="grp">
    <rect id="c" x="120" y="10" width="10" height="10"/>
  </g>
  <text id="t" x="10" y="80">Hi</text>
</svg>
`;

const byAttr = (ed: Editor, id: string) => ed.doc.query({ attr: { id } })[0]!;

/** UI action -> SDK equivalent, run against a fresh editor. */
const PARITY: { ui: string; sdk: string; run: (ed: Editor) => void | Promise<void> }[] = [
  { ui: "Open a file", sdk: "createEditor({ svg })", run: (ed) => expect(ed.text).toBe(SRC) },
  { ui: "New document", sdk: "createEditor()", run: () => expect(createEditor().doc.query()).toHaveLength(1) },
  {
    ui: "Type in the code pane",
    sdk: "editor.setText(text)",
    run: (ed) => {
      ed.setText(SRC.replace('r="10"', 'r="12"'));
      expect(ed.doc.getNode(byAttr(ed, "b")).attrs.r).toBe("12");
    },
  },
  { ui: "Broken code keeps the last good model", sdk: "setText throws PARSE_ERROR", run: (ed) => expect(() => ed.setText("<svg><g></svg>")).toThrow(SvgEditorError) },
  { ui: "Save (text with formatting kept)", sdk: "editor.text", run: (ed) => expect(ed.text).toContain("<!-- scene -->") },
  {
    ui: "Click / Shift-click / Ctrl-click select",
    sdk: "editor.select(ids), doc.topLevel()",
    run: (ed) => {
      expect(ed.doc.topLevel()).toContain(byAttr(ed, "grp"));
      ed.select([byAttr(ed, "a"), byAttr(ed, "c")]);
      expect(ed.getSelection()).toHaveLength(2);
    },
  },
  { ui: "Marquee select", sdk: "editor.selectInRect(rect)", run: (ed) => expect(ed.selectInRect({ x: 0, y: 0, width: 100, height: 40 })).toEqual([byAttr(ed, "a"), byAttr(ed, "b")]) },
  {
    ui: "Code cursor selects a node / selection highlights code",
    sdk: "editor.nodeAt(offset), editor.getSourceRange(id)",
    run: (ed) => {
      const r = ed.getSourceRange(byAttr(ed, "b"))!;
      expect(ed.nodeAt(r.start + 2)).toBe(byAttr(ed, "b"));
    },
  },
  { ui: "Drag to move / arrow keys", sdk: "doc.transform(id, { translate })", run: (ed) => expect(ed.doc.transform(byAttr(ed, "a"), { translate: [5, 0] })).toBe("translate(5 0)") },
  {
    ui: "Resize handle (one element, its own axes)",
    sdk: 'doc.transform(id, { scale, origin, space: "local" })',
    run: (ed) => expect(ed.doc.transform(byAttr(ed, "a"), { scale: [2, 1], origin: [10, 10], space: "local" })).toContain("scale(2 1)"),
  },
  { ui: "Rotate handle", sdk: "doc.transform(id, { rotate, origin })", run: (ed) => expect(ed.doc.transform(byAttr(ed, "b"), { rotate: 45, origin: "center" })).toBe("rotate(45 80 20)") },
  {
    ui: "Gesture on several elements is one undo step",
    sdk: "editor.batch(fn)",
    run: (ed) => {
      ed.batch(() => ["a", "b"].forEach((i) => ed.doc.transform(byAttr(ed, i), { translate: [1, 1] })));
      ed.undo();
      expect(ed.text).toBe(SRC);
    },
  },
  { ui: "Rect / ellipse / line tools", sdk: "doc.add(tag, attrs)", run: (ed) => expect(ed.doc.getNode(ed.doc.add("ellipse", { cx: 5, cy: 5, rx: 3, ry: 2 })).tag).toBe("ellipse") },
  {
    ui: "Text tool",
    sdk: "doc.addText(text, attrs)",
    run: (ed) => {
      ed.doc.addText("New", { x: 1, y: 1 });
      expect(ed.text).toContain(">New</text>");
    },
  },
  { ui: "Delete key", sdk: "doc.delete(ids)", run: (ed) => (ed.doc.delete(byAttr(ed, "a")), expect(ed.doc.query({ tag: "rect" })).toHaveLength(1)) },
  {
    ui: "Layers panel: drag to reorder / into a group",
    sdk: "doc.move(id, parent, index)",
    run: (ed) => {
      ed.doc.move(byAttr(ed, "b"), byAttr(ed, "grp"), 0);
      expect(ed.doc.getNode(byAttr(ed, "grp")).children[0]).toBe(byAttr(ed, "b"));
    },
  },
  {
    ui: "Properties panel: edit / add / remove attribute",
    sdk: "doc.set(id, { name: value | null })",
    run: (ed) => {
      ed.doc.set(byAttr(ed, "a"), { fill: "red", width: null });
      expect(ed.doc.getNode(byAttr(ed, "a")).attrs).toMatchObject({ fill: "red" });
    },
  },
  { ui: "Properties panel: text content", sdk: "doc.setText(id, text)", run: (ed) => (ed.doc.setText(byAttr(ed, "t"), "Bye"), expect(ed.text).toContain(">Bye</text>")) },
  {
    ui: "Undo / redo",
    sdk: "editor.undo(), editor.redo()",
    run: (ed) => {
      ed.doc.delete(byAttr(ed, "a"));
      ed.undo();
      expect(ed.text).toBe(SRC);
      ed.redo();
      expect(ed.doc.query({ tag: "rect" })).toHaveLength(1);
    },
  },
  {
    ui: "Export PNG",
    sdk: "editor.exportPng() (rasterize bridge)",
    run: async (ed) => {
      ed.setBridges({ rasterize: async () => new Uint8Array([1]) });
      expect(await ed.exportPng()).toEqual(new Uint8Array([1]));
    },
  },
  {
    ui: "AI turn / Debug > Simulate AI turn (editor locked)",
    sdk: "editor.runLocked(options, fn) / editor.lock()",
    run: async (ed) => {
      await ed.runLocked({ reason: "ai" }, (s) => s.doc.add("circle"));
      expect(ed.doc.query({ tag: "circle" })).toHaveLength(2);
    },
  },
  {
    ui: "Lock banner: Stop / Stop & keep changes",
    sdk: "editor.stopLock({ keep })",
    run: (ed) => {
      const s = ed.lock({ reason: "ai" });
      s.doc.add("ellipse");
      expect(ed.stopLock({ keep: false })).toMatchObject({ kept: false, stopped: true });
      expect(ed.text).toBe(SRC);
    },
  },
];

/** UI features that change only the view, not the document. Nothing to expose in the SDK. */
const VIEW_ONLY: Record<string, string> = {
  zoomIn: "zoom level",
  zoomOut: "zoom level",
  zoom100: "zoom level",
  zoomFit: "zoom level",
  toggleGrid: "grid display",
  toggleSnap: "snapping only rounds coordinates the caller then passes to doc.add / doc.transform",
  select: "the select tool picks a mode for pointer input",
};

/** Menu actions and tools mapped to a PARITY row (by `ui`). */
const MAPPED: Record<string, string> = {
  new: "New document",
  open: "Open a file",
  save: "Save (text with formatting kept)",
  saveAs: "Save (text with formatting kept)",
  saveAndClose: "Save (text with formatting kept)",
  exportPng: "Export PNG",
  rect: "Rect / ellipse / line tools",
  ellipse: "Rect / ellipse / line tools",
  line: "Rect / ellipse / line tools",
  text: "Text tool",
  simulateAiTurn: "AI turn / Debug > Simulate AI turn (editor locked)",
};

describe("UI cannot bypass the SDK", () => {
  const renderer = readdirSync(new URL("renderer/", app)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it.each(renderer)("renderer/%s imports model and parser for types only", (file) => {
    const src = read(`renderer/${file}`);
    const runtime = [...src.matchAll(/^import\s+(?!type\b)[^;]*from\s+"(@svg-editor\/(?:model|parser))"/gm)].map((m) => m[1]);
    expect(runtime).toEqual([]);
    expect(src).not.toMatch(/\.model\b\.?/); // Editor#model is internal
  });

  it("main and preload do not touch documents", () => {
    for (const f of ["main/index.ts", "preload/index.ts"]) expect(read(f)).not.toMatch(/@svg-editor\//);
  });
});

describe.each(PARITY)("UI: $ui -> SDK: $sdk", ({ run }) => {
  it("works headlessly", async () => {
    await run(createEditor({ svg: SRC }));
  });
});

describe("every UI action is accounted for", () => {
  const menuActions = [...read("shared/api.ts").matchAll(/\|\s*"(\w+)"/g)].map((m) => m[1]!);
  const tools = [...read("renderer/canvas.ts").matchAll(/export type Tool = ([^;]+);/g)][0]![1]!.match(/"(\w+)"/g)!.map((t) => t.slice(1, -1));

  it("found the app's menu actions and tools", () => {
    expect(menuActions).toContain("exportPng");
    expect(tools).toEqual(["select", "rect", "ellipse", "line", "text"]);
  });

  it.each([...menuActions, ...tools])("%s is mapped to the SDK or marked view-only", (action) => {
    const mapped = MAPPED[action];
    if (mapped) expect(PARITY.map((p) => p.ui)).toContain(mapped);
    else expect(VIEW_ONLY[action], `"${action}" is a UI action with no SDK mapping: add it to PARITY/MAPPED or, if it only changes the view, to VIEW_ONLY`).toBeDefined();
  });
});
