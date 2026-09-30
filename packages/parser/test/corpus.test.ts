import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEXT_TAG, type Command, type TreeNode } from "@svg-editor/model";
import { openSvg } from "../src/index.js";
import { open } from "./helpers.js";

const dir = new URL("./corpus/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".svg"));

function stripIds(t: TreeNode): unknown {
  return { tag: t.tag, attrs: t.attrs, text: t.text, children: t.children.map(stripIds) };
}

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe.each(files)("corpus: %s", (file) => {
  const original = readFileSync(new URL(file, dir), "utf8");

  it("parses and re-serializes the model faithfully", () => {
    const s = open(original);
    expect(s.text).toBe(original);
    const again = openSvg(s.doc.toSvg());
    expect(again.ok).toBe(true);
    if (again.ok) expect(stripIds(again.source.doc.getTree()!)).toEqual(stripIds(s.doc.getTree()!));
  });

  it("set on one attribute touches only that attribute's value", () => {
    const s = open(original);
    for (const id of s.doc.query()) {
      const node = s.doc.getNode(id)!;
      const name = Object.keys(node.attrs)[0];
      if (!name) continue;
      const before = s.text;
      const src = s.getSource(id)!;
      ok(s.doc.execute({ op: "set", id, attrs: { [name]: `${node.attrs[name]}_x` } }));
      const change = s.changes.at(-1)!;
      expect(change.method).toBe("patch");
      expect(change.edits).toHaveLength(1);
      const { from, to } = change.edits[0]!;
      expect(from).toBeGreaterThanOrEqual(src.start);
      expect(to).toBeLessThanOrEqual(src.end);
      expect(before.slice(0, from)).toBe(s.text.slice(0, from));
      expect(before.slice(to)).toBe(s.text.slice(s.text.length - (before.length - to)));
    }
    while (s.doc.undo());
    expect(s.text).toBe(original);
  });

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`random edits stay minimal and undo byte-exactly (seed ${seed})`, () => {
      const s = open(original);
      const rand = rng(seed * 7919 + file.length);
      const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(rand() * xs.length)];
      const elements = () => s.doc.query().filter((id) => id !== s.doc.root);
      const textHosts = () =>
        s.doc.query().filter((id) => {
          const n = s.doc.getNode(id)!;
          return n.tag !== "svg" && n.children.every((c) => s.doc.getNode(c)!.tag === TEXT_TAG);
        });

      const randomCommand = (): Command | undefined => {
        const id = pick(elements());
        const any = pick(s.doc.query());
        switch (Math.floor(rand() * 13)) {
          case 0: {
            if (!id) return undefined;
            const attrs = s.doc.getNode(id)!.attrs;
            const key = pick(Object.keys(attrs));
            return { op: "set", id, attrs: key && rand() < 0.4 ? { [key]: null } : { [key ?? "data-k"]: `v${Math.floor(rand() * 100)}` } };
          }
          case 1:
            return any ? { op: "add", parent: any, index: Math.floor(rand() * (s.doc.getNode(any)!.children.length + 1)), tag: "rect", attrs: { width: "1" } } : undefined;
          case 2:
            return id ? { op: "delete", ids: [id] } : undefined;
          case 3: {
            if (!id || !any) return undefined;
            const siblings = s.doc.getNode(any)!.children.length;
            return { op: "move", id, parent: any, index: Math.floor(rand() * (siblings + 1)) };
          }
          case 4: {
            if (!id) return undefined;
            const parent = s.doc.getNode(s.doc.getNode(id)!.parent!)!;
            const els = parent.children.filter((c) => s.doc.getNode(c)!.tag !== TEXT_TAG);
            return { op: "group", ids: els.slice(0, 1 + Math.floor(rand() * els.length)) };
          }
          case 5: {
            const g = pick(s.doc.query({ tag: "g" }));
            return g ? { op: "ungroup", id: g } : undefined;
          }
          case 6:
            return id ? { op: "transform", id, translate: [Math.round(rand() * 10), 1] } : undefined;
          case 7: {
            const host = pick(textHosts());
            return host ? { op: "setText", id: host, text: rand() < 0.2 ? "" : `t${Math.floor(rand() * 9)} & <x>` } : undefined;
          }
          case 8:
            return id ? { op: "convertToPath", id } : undefined;
          case 9: {
            const p = pick(s.doc.query({ tag: "path" }));
            return p ? { op: "pathEdit", id: p, moves: [{ seg: Math.floor(rand() * 3), point: "p", to: [Math.round(rand() * 50), Math.round(rand() * 50)] }] } : undefined;
          }
          case 10: {
            if (!id) return undefined;
            const sibs = s.doc.getNode(s.doc.getNode(id)!.parent!)!.children.filter((c) => c !== id && s.doc.getNode(c)!.tag !== TEXT_TAG);
            const other = pick(sibs);
            const ops = ["union", "subtract", "intersect", "exclude"] as const;
            return other ? { op: "boolean", operation: ops[Math.floor(rand() * 4)]!, ids: [id, other] } : undefined;
          }
          case 11: {
            const p = pick(s.doc.query({ tag: "path" }));
            return p ? { op: "simplify", id: p, tolerance: 0.5 + rand() * 3 } : undefined;
          }
          default: {
            const a = randomCommand();
            const b = randomCommand();
            return a && b ? { op: "batch", commands: [a, b] } : undefined;
          }
        }
      };

      let applied = 0;
      for (let step = 0; step < 60; step++) {
        const cmd = randomCommand();
        if (!cmd) continue;
        const before = s.text;
        const r = s.doc.execute(cmd);
        if (!r.ok) {
          expect(s.text, `failed ${cmd.op} must not change text`).toBe(before);
          continue;
        }
        applied++;
        expect(s.fallbacks, `fallback after ${JSON.stringify(cmd)}`).toBe(0);
        const fresh = openSvg(s.text);
        expect(fresh.ok).toBe(true);
        if (fresh.ok) expect(stripIds(fresh.source.doc.getTree()!)).toEqual(stripIds(s.doc.getTree()!));
      }
      expect(applied).toBeGreaterThan(0);

      const after = s.text;
      while (s.doc.undo());
      expect(s.text).toBe(original);
      while (s.doc.redo());
      expect(s.text).toBe(after);
      expect(s.fallbacks).toBe(0);
    });
  }
});

function ok<T>(r: { ok: true; result: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result;
}
