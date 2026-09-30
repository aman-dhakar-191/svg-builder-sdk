import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor, SvgEditorError, type Editor } from "../src/index.js";

const SRC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- keep me -->
  <rect x="1" y="1" width="10" height="10"/>
</svg>
`;

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SvgEditorError);
    return (e as SvgEditorError).code;
  }
  return undefined;
}

let ed: Editor;
const rect = () => ed.doc.query({ tag: "rect" })[0]!;

afterEach(() => {
  vi.useRealTimers();
});

describe("while locked", () => {
  it("blocks every write that is not the session's, at the SDK level", () => {
    ed = createEditor({ svg: SRC });
    ed.doc.add("circle"); // something to undo
    const s = ed.lock({ reason: "ai", label: "AI is editing" });
    expect(code(() => ed.doc.set(rect(), { x: 5 }))).toBe("LOCKED");
    expect(code(() => ed.doc.add("rect"))).toBe("LOCKED");
    expect(code(() => ed.doc.addText("x"))).toBe("LOCKED");
    expect(code(() => ed.setText(SRC))).toBe("LOCKED");
    expect(code(() => ed.undo())).toBe("LOCKED");
    expect(code(() => ed.redo())).toBe("LOCKED");
    expect(code(() => ed.batch(() => 1))).toBe("LOCKED");
    expect(code(() => ed.beginBatch())).toBe("LOCKED");
    expect(ed.execute({ op: "delete", ids: [rect()] })).toMatchObject({ ok: false, error: { code: "LOCKED", message: expect.stringContaining("AI is editing") } });
    expect(code(() => ed.lock({ reason: "other" }))).toBe("LOCKED");
    s.rollback();
  });

  it("still allows reads and selection", () => {
    ed = createEditor({ svg: SRC });
    const s = ed.lock({ reason: "ai" });
    expect(ed.doc.getNode(rect()).tag).toBe("rect");
    expect(ed.text).toBe(SRC);
    ed.select(rect());
    expect(ed.getSelection()).toEqual([rect()]);
    s.rollback();
  });

  it("the session writes, and the change stream keeps flowing (for a live code view)", () => {
    ed = createEditor({ svg: SRC });
    const events: string[] = [];
    ed.onChange((e) => events.push(e.origin));
    const s = ed.lock({ reason: "ai" });
    s.doc.set(rect(), { fill: "red" });
    expect(s.execute({ op: "add", tag: "circle", attrs: { r: "2" } })).toMatchObject({ ok: true });
    expect(ed.text).toContain('fill="red"');
    expect(events.length).toBeGreaterThanOrEqual(2);
    s.commit();
  });
});

describe("ending a session", () => {
  it("commit keeps everything as one undo step and unlocks", () => {
    ed = createEditor({ svg: SRC });
    const s = ed.lock({ reason: "ai" });
    s.doc.set(rect(), { fill: "red" });
    s.doc.addText("Hi", { x: 1, y: 50 });
    s.doc.add("circle", { r: 3 });
    expect(s.commit()).toEqual({ kept: true, changed: true, stopped: false });
    expect(ed.lockInfo).toBeNull();
    ed.undo();
    expect(ed.text).toBe(SRC);
    ed.redo();
    expect(ed.doc.query({ tag: "circle" })).toHaveLength(1);
    ed.doc.add("line"); // writable again
  });

  it("rollback restores the original bytes", () => {
    ed = createEditor({ svg: SRC });
    const s = ed.lock({ reason: "ai" });
    s.doc.delete(rect());
    s.doc.add("ellipse");
    expect(s.rollback()).toEqual({ kept: false, changed: true, stopped: false });
    expect(ed.text).toBe(SRC);
    expect(ed.canUndo()).toBe(false);
  });

  it("stop() aborts the signal and rolls back by default; keep: true keeps partial work", () => {
    ed = createEditor({ svg: SRC });
    const s = ed.lock({ reason: "ai" });
    let aborted = false;
    s.signal.addEventListener("abort", () => (aborted = true));
    s.doc.add("circle");
    expect(s.stop()).toEqual({ kept: false, changed: true, stopped: true });
    expect(aborted).toBe(true);
    expect(s.signal.reason).toBeInstanceOf(SvgEditorError);
    expect(ed.text).toBe(SRC);

    const s2 = ed.lock({ reason: "ai" });
    s2.doc.add("circle");
    expect(s2.stop({ keep: true })).toEqual({ kept: true, changed: true, stopped: true });
    expect(ed.doc.query({ tag: "circle" })).toHaveLength(1);
    ed.undo();
    expect(ed.text).toBe(SRC);
  });

  it("the UI can stop a session it does not own (stopLock)", () => {
    ed = createEditor({ svg: SRC });
    const s = ed.lock({ reason: "ai" });
    s.doc.add("circle");
    expect(ed.stopLock()).toEqual({ kept: false, changed: true, stopped: true });
    expect(s.active).toBe(false);
    expect(s.stopped).toBe(true);
    expect(ed.stopLock()).toBeNull();
  });

  it("a finished session cannot write or end again", () => {
    ed = createEditor({ svg: SRC });
    const s = ed.lock({ reason: "ai" });
    s.commit();
    expect(code(() => s.doc.add("rect"))).toBe("LOCK_RELEASED");
    expect(s.execute({ op: "add", tag: "rect", attrs: {} })).toMatchObject({ ok: false, error: { code: "LOCK_RELEASED" } });
    expect(code(() => s.commit())).toBe("LOCK_RELEASED");
    // ...and it cannot write into a later session either.
    const s2 = ed.lock({ reason: "ai" });
    expect(code(() => s.doc.add("rect"))).toBe("LOCK_RELEASED");
    s2.rollback();
  });

  it("no changes: nothing reaches history", () => {
    ed = createEditor({ svg: SRC });
    expect(ed.lock({ reason: "ai" }).commit()).toEqual({ kept: false, changed: false, stopped: false });
    expect(ed.canUndo()).toBe(false);
  });

  it("session.batch rolls back only its own part on error", () => {
    ed = createEditor({ svg: SRC });
    const s = ed.lock({ reason: "ai" });
    s.doc.add("circle");
    expect(() =>
      s.batch(() => {
        s.doc.add("ellipse");
        s.doc.delete("n_404");
      }),
    ).toThrow(SvgEditorError);
    s.commit();
    expect(ed.doc.query({ tag: "circle" })).toHaveLength(1);
    expect(ed.doc.query({ tag: "ellipse" })).toHaveLength(0);
  });

  it("refuses to lock in the middle of a batch", () => {
    ed = createEditor({ svg: SRC });
    ed.batch(() => {
      expect(code(() => ed.lock({ reason: "ai" }))).toBe("LOCKED");
    });
    expect(ed.lockInfo).toBeNull();
  });

  it("timeoutMs stops and rolls back automatically", () => {
    vi.useFakeTimers();
    ed = createEditor({ svg: SRC });
    const s = ed.lock({ reason: "ai", timeoutMs: 1000 });
    s.doc.add("circle");
    vi.advanceTimersByTime(999);
    expect(s.active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(s.active).toBe(false);
    expect(s.stopped).toBe(true);
    expect(ed.text).toBe(SRC);
  });
});

describe("runLocked", () => {
  it("commits on success", async () => {
    ed = createEditor({ svg: SRC });
    const id = await ed.runLocked({ reason: "ai" }, async (s) => {
      await Promise.resolve();
      return s.doc.add("circle", { r: 4 });
    });
    expect(ed.doc.getNode(id).attrs.r).toBe("4");
    expect(ed.lockInfo).toBeNull();
  });

  it("rolls back and rethrows on error, and always unlocks", async () => {
    ed = createEditor({ svg: SRC });
    await expect(
      ed.runLocked({ reason: "ai" }, async (s) => {
        s.doc.add("circle");
        throw new Error("model request failed");
      }),
    ).rejects.toThrow("model request failed");
    expect(ed.lockInfo).toBeNull();
    expect(ed.text).toBe(SRC);
  });

  it("Stop during the run: rolls back, unlocks at once, and the run rejects with LOCK_STOPPED", async () => {
    ed = createEditor({ svg: SRC });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = ed.runLocked({ reason: "ai" }, async (s) => {
      s.doc.add("circle");
      await gate; // e.g. waiting for the model
      s.doc.add("ellipse"); // too late: the session is gone
    });
    await Promise.resolve();
    ed.stopLock();
    expect(ed.lockInfo).toBeNull(); // unlocked immediately, not when the run notices
    expect(ed.text).toBe(SRC);
    release();
    await expect(run).rejects.toMatchObject({ code: "LOCK_STOPPED" });
    expect(ed.text).toBe(SRC);
  });

  it("Stop with keep: partial work stays as one undo step", async () => {
    ed = createEditor({ svg: SRC });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = ed.runLocked({ reason: "ai" }, async (s) => {
      s.doc.add("circle");
      await gate;
      if (s.signal.aborted) return "noticed";
      return "missed";
    });
    await Promise.resolve();
    ed.stopLock({ keep: true });
    release();
    await expect(run).rejects.toMatchObject({ code: "LOCK_STOPPED" });
    expect(ed.doc.query({ tag: "circle" })).toHaveLength(1);
    ed.undo();
    expect(ed.text).toBe(SRC);
  });

  it("reports lock changes for the UI banner", async () => {
    ed = createEditor({ svg: SRC });
    const seen: (string | null)[] = [];
    ed.onLockChange((info) => seen.push(info ? info.label : null));
    await ed.runLocked({ reason: "ai", label: "AI is drawing" }, () => undefined);
    expect(seen).toEqual(["AI is drawing", null]);
  });
});
