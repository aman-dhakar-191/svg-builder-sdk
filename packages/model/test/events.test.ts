import { describe, expect, it } from "vitest";
import { createDocument, TEXT_TAG, type HistoryEvent, type Mutation } from "../src/index.js";
import { ok, snapshot } from "./helpers.js";

describe("createDocument({ tree })", () => {
  it("keeps given IDs and never collides with them", () => {
    const doc = createDocument({
      tree: { id: "n_7", tag: "svg", attrs: {}, children: [{ tag: "rect", attrs: { x: "1" }, children: [] }, { id: "n_3", tag: "g", attrs: {}, children: [] }] },
    });
    expect(doc.root).toBe("n_7");
    const [fresh, kept] = doc.getNode("n_7")!.children;
    expect(kept).toBe("n_3");
    expect(Number(fresh!.slice(2))).toBeGreaterThan(7);
    const added = ok(doc.execute({ op: "add", tag: "circle", attrs: {} })).id;
    expect([fresh, "n_3", "n_7"]).not.toContain(added);
  });

  it("rejects duplicate IDs", () => {
    expect(() => createDocument({ tree: { id: "n_1", tag: "svg", attrs: {}, children: [{ id: "n_1", tag: "g", attrs: {}, children: [] }] } })).toThrow(/Duplicate/);
  });
});

describe("events", () => {
  it("reports every mutation, including undo and rollback", () => {
    const doc = createDocument();
    const seen: Mutation["kind"][] = [];
    const off = doc.onMutation((m) => seen.push(m.kind));
    const id = ok(doc.execute({ op: "add", tag: "rect", attrs: {} })).id;
    doc.execute({ op: "batch", commands: [{ op: "set", id, attrs: { x: "1" } }, { op: "delete", ids: ["n_99"] }] });
    doc.undo();
    expect(seen).toEqual(["insert", "attrs", "attrs", "remove"]);
    off();
    doc.redo();
    expect(seen).toHaveLength(4);
  });

  it("reports history boundaries with a stable entry token", () => {
    const doc = createDocument();
    const events: HistoryEvent[] = [];
    doc.onHistory((e) => events.push(e));
    ok(doc.execute({ op: "add", tag: "rect", attrs: {} }));
    doc.execute({ op: "delete", ids: ["n_99"] });
    doc.undo();
    doc.redo();
    expect(events.map((e) => e.kind)).toEqual(["commit", "discard", "undo", "redo"]);
    const [commit, , undo, redo] = events as { entry: object }[];
    expect(undo!.entry).toBe(commit!.entry);
    expect(redo!.entry).toBe(commit!.entry);
  });
});

describe("text normalization", () => {
  it("merges text left adjacent by delete and move, and undo splits it again", () => {
    const doc = createDocument({
      tree: { tag: "svg", attrs: {}, children: [{ tag: "text", attrs: {}, children: [
        { tag: TEXT_TAG, attrs: {}, text: "a", children: [] },
        { tag: "tspan", attrs: {}, children: [] },
        { tag: TEXT_TAG, attrs: {}, text: "b", children: [] },
      ] }] },
    });
    const text = doc.query({ tag: "text" })[0]!;
    const tspan = doc.query({ tag: "tspan" })[0]!;
    const before = snapshot(doc);
    ok(doc.execute({ op: "delete", ids: [tspan] }));
    expect(doc.getTree(text)!.children.map((c) => c.text)).toEqual(["ab"]);
    doc.undo();
    expect(snapshot(doc)).toEqual(before);
    ok(doc.execute({ op: "move", id: tspan, parent: doc.root, index: 0 }));
    expect(doc.getTree(text)!.children.map((c) => c.text)).toEqual(["ab"]);
    doc.undo();
    expect(snapshot(doc)).toEqual(before);
  });

  it("removes a text node set to empty", () => {
    const doc = createDocument();
    const t = ok(doc.execute({ op: "add", tag: "text", attrs: {} })).id;
    ok(doc.execute({ op: "setText", id: t, text: "x" }));
    const node = doc.getNode(t)!.children[0]!;
    ok(doc.execute({ op: "setText", id: node, text: "" }));
    expect(doc.getNode(t)!.children).toEqual([]);
  });
});

describe("pretty printing", () => {
  it("never indents inside text containers", () => {
    const doc = createDocument({ rootAttrs: {} });
    const t = ok(doc.execute({ op: "add", tag: "text", attrs: {} })).id;
    ok(doc.execute({ op: "add", tag: "tspan", attrs: {}, parent: t }));
    ok(doc.execute({ op: "add", tag: "tspan", attrs: {}, parent: t }));
    expect(doc.toSvg({ pretty: true })).toBe("<svg>\n  <text><tspan/><tspan/></text>\n</svg>");
  });
});
