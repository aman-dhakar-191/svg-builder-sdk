import { beforeEach, describe, expect, it } from "vitest";
import { createDocument, type Command, type SvgDocument } from "../src/index.js";
import { err, ok, snapshot } from "./helpers.js";

let doc: SvgDocument;
beforeEach(() => {
  doc = createDocument();
});

describe("undo/redo", () => {
  it("returns false when there is nothing to undo or redo", () => {
    expect(doc.canUndo()).toBe(false);
    expect(doc.undo()).toBe(false);
    expect(doc.redo()).toBe(false);
  });

  it("walks a long sequence of every command back to empty and forward again", () => {
    const states = [snapshot(doc)];
    const run = (cmd: Command) => {
      const r = ok(doc.execute(cmd));
      states.push(snapshot(doc));
      return r as { id: string };
    };
    const a = run({ op: "add", tag: "rect", attrs: { width: "10", height: "10" } }).id;
    const b = run({ op: "add", tag: "circle", attrs: { r: "4" } }).id;
    const t = run({ op: "add", tag: "text", attrs: {} }).id;
    run({ op: "setText", id: t, text: "hi" });
    run({ op: "set", id: a, attrs: { fill: "red" } });
    run({ op: "transform", id: a, rotate: 15, origin: "center" });
    const g = run({ op: "group", ids: [a, b] }).id;
    run({ op: "set", id: g, attrs: { stroke: "black" } });
    run({ op: "move", id: t, parent: g, index: 0 });
    run({ op: "ungroup", id: g });
    run({ op: "delete", ids: [b] });

    for (let i = states.length - 2; i >= 0; i--) {
      expect(doc.undo()).toBe(true);
      expect(snapshot(doc)).toEqual(states[i]);
    }
    expect(doc.canUndo()).toBe(false);
    for (let i = 1; i < states.length; i++) {
      expect(doc.redo()).toBe(true);
      expect(snapshot(doc)).toEqual(states[i]);
    }
    expect(doc.canRedo()).toBe(false);
  });

  it("clears the redo stack on a new change, but not on a no-op or failed command", () => {
    const id = ok(doc.execute({ op: "add", tag: "rect", attrs: { x: "1" } })).id;
    ok(doc.execute({ op: "set", id, attrs: { x: "2" } }));
    doc.undo();
    ok(doc.execute({ op: "set", id, attrs: { x: "1" } })); // no-op
    err(doc.execute({ op: "set", id: "n_999", attrs: {} }));
    expect(doc.canRedo()).toBe(true);
    ok(doc.execute({ op: "set", id, attrs: { y: "3" } }));
    expect(doc.canRedo()).toBe(false);
  });

  it("redo reuses the original IDs", () => {
    const id = ok(doc.execute({ op: "add", tag: "rect", attrs: {} })).id;
    doc.undo();
    doc.redo();
    expect(doc.getNode(id)?.tag).toBe("rect");
    ok(doc.execute({ op: "set", id, attrs: { x: "1" } }));
  });

  it("bumps version on every change including undo and redo", () => {
    const v0 = doc.version;
    ok(doc.execute({ op: "add", tag: "rect", attrs: {} }));
    const v1 = doc.version;
    expect(v1).toBeGreaterThan(v0);
    doc.undo();
    expect(doc.version).toBeGreaterThan(v1);
    const v2 = doc.version;
    doc.redo();
    expect(doc.version).toBeGreaterThan(v2);
  });
});

describe("batch command", () => {
  it("is a single undo step", () => {
    const before = snapshot(doc);
    const r = ok(
      doc.execute({
        op: "batch",
        commands: [
          { op: "add", tag: "rect", attrs: {} },
          { op: "add", tag: "circle", attrs: {} },
          { op: "set", id: "n_2", attrs: { fill: "red" } },
          { op: "group", ids: ["n_2", "n_3"] },
        ],
      }),
    );
    expect(r.results).toEqual([{ id: "n_2" }, { id: "n_3" }, { id: "n_2" }, { id: "n_4" }]);
    const after = snapshot(doc);
    expect(doc.undo()).toBe(true);
    expect(snapshot(doc)).toEqual(before);
    expect(doc.canUndo()).toBe(false);
    expect(doc.redo()).toBe(true);
    expect(snapshot(doc)).toEqual(after);
  });

  it("is atomic: a failing sub-command rolls back the whole batch with a path to it", () => {
    ok(doc.execute({ op: "add", tag: "rect", attrs: {} }));
    const before = snapshot(doc);
    const e = err(
      doc.execute({
        op: "batch",
        commands: [
          { op: "add", tag: "circle", attrs: {} },
          { op: "batch", commands: [{ op: "set", id: "n_2", attrs: { x: "1" } }, { op: "delete", ids: ["n_404"] }] },
        ],
      }),
    );
    expect(e.code).toBe("BATCH_FAILED");
    expect(e.path).toEqual([1, 1]);
    expect(e.cause?.code).toBe("NOT_FOUND");
    expect(e.message).toContain("n_404");
    expect(snapshot(doc)).toEqual(before);
    doc.undo(); // only the earlier add is in history
    expect(doc.getTree()!.children).toEqual([]);
    expect(doc.canUndo()).toBe(false);
  });

  it("empty batch records nothing", () => {
    ok(doc.execute({ op: "batch", commands: [] }));
    expect(doc.canUndo()).toBe(false);
  });

  it("rejects a non-array", () => {
    expect(err(doc.execute({ op: "batch", commands: "nope" } as never)).code).toBe("INVALID_COMMAND");
  });
});

describe("transactions", () => {
  it("transaction(fn) groups several commands into one undo step", () => {
    const ids = doc.transaction(() => [
      ok(doc.execute({ op: "add", tag: "rect", attrs: {} })).id,
      ok(doc.execute({ op: "add", tag: "circle", attrs: {} })).id,
    ]);
    expect(doc.getTree()!.children.map((c) => c.id)).toEqual(ids);
    doc.undo();
    expect(doc.getTree()!.children).toEqual([]);
    expect(doc.canUndo()).toBe(false);
  });

  it("rolls back and rethrows when fn throws", () => {
    const before = snapshot(doc);
    expect(() =>
      doc.transaction(() => {
        ok(doc.execute({ op: "add", tag: "rect", attrs: {} }));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(snapshot(doc)).toEqual(before);
    expect(doc.canUndo()).toBe(false);
    expect(doc.inTransaction).toBe(false);
  });

  it("a failed command inside a transaction only undoes itself", () => {
    doc.transaction(() => {
      ok(doc.execute({ op: "add", tag: "rect", attrs: {} }));
      err(doc.execute({ op: "batch", commands: [{ op: "add", tag: "circle", attrs: {} }, { op: "ungroup", id: "n_2" }] }));
    });
    expect(doc.getTree()!.children.map((c) => c.tag)).toEqual(["rect"]);
  });

  it("nests: inner rollback keeps outer work; outermost commit is one step", () => {
    const outer = doc.beginTransaction();
    ok(doc.execute({ op: "add", tag: "rect", attrs: {} }));
    const inner = doc.beginTransaction();
    ok(doc.execute({ op: "add", tag: "circle", attrs: {} }));
    inner.rollback();
    const inner2 = doc.beginTransaction();
    ok(doc.execute({ op: "add", tag: "line", attrs: {} }));
    inner2.commit();
    expect(doc.canUndo()).toBe(false); // nothing committed to history yet
    outer.commit();
    expect(doc.getTree()!.children.map((c) => c.tag)).toEqual(["rect", "line"]);
    doc.undo();
    expect(doc.getTree()!.children).toEqual([]);
  });

  it("supports async work via beginTransaction (e.g. a whole AI turn)", async () => {
    const tx = doc.beginTransaction();
    ok(doc.execute({ op: "add", tag: "rect", attrs: {} }));
    await Promise.resolve();
    ok(doc.execute({ op: "add", tag: "circle", attrs: {} }));
    tx.rollback();
    expect(doc.getTree()!.children).toEqual([]);
    expect(doc.canUndo()).toBe(false);
  });

  it("rejects a Promise-returning transaction(fn) and rolls it back", () => {
    expect(() =>
      doc.transaction(() => {
        ok(doc.execute({ op: "add", tag: "rect", attrs: {} }));
        return Promise.resolve();
      }),
    ).toThrow(/beginTransaction/);
    expect(doc.getTree()!.children).toEqual([]);
  });

  it("enforces closing order and blocks undo/redo while open", () => {
    const outer = doc.beginTransaction();
    const inner = doc.beginTransaction();
    expect(() => outer.commit()).toThrow(/innermost/);
    expect(() => doc.undo()).toThrow(/transaction/);
    expect(() => doc.redo()).toThrow(/transaction/);
    inner.commit();
    outer.commit();
    expect(() => outer.commit()).toThrow(/already closed/);
  });
});
