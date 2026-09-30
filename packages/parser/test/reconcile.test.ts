import { describe, expect, it } from "vitest";
import type { InputTree } from "@svg-editor/model";
import { parseSvg, reconcile, type ParsedElement } from "../src/index.js";
import { open } from "./helpers.js";

const BASE = `<svg>
  <g id="layer">
    <rect x="1" fill="red"/>
    <circle r="2"/>
    <text>hi</text>
  </g>
  <path d="M0 0"/>
</svg>`;

function parse(text: string): ParsedElement {
  const r = parseSvg(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.root;
}

/** tag -> id of the first node with that tag in the reconciled tree */
function ids(tree: InputTree): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const walk = (n: InputTree) => {
    if (!(n.tag in out)) out[n.tag] = n.id;
    n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

describe("reconcile", () => {
  const s = open(BASE);
  const before = ids(s.doc.getTree()!);

  it("keeps every ID when nothing changed", () => {
    const r = reconcile(s.doc, parse(BASE));
    expect(ids(r.tree)).toEqual(before);
    expect(r.created).toBe(0);
    expect(r.removed).toEqual([]);
  });

  it("keeps IDs through attribute and text edits", () => {
    const r = reconcile(s.doc, parse(BASE.replace('x="1"', 'x="50" y="3"').replace(">hi<", ">hello<")));
    expect(ids(r.tree)).toEqual(before);
  });

  it("gives inserted nodes new IDs and keeps the rest", () => {
    const r = reconcile(s.doc, parse(BASE.replace("<circle", '<ellipse rx="1"/>\n    <circle')));
    const after = ids(r.tree);
    expect(after.ellipse).toBeUndefined();
    expect({ ...after, ellipse: undefined }).toEqual({ ...before, ellipse: undefined });
    expect(r.created).toBe(1);
  });

  it("drops deleted nodes' IDs", () => {
    const r = reconcile(s.doc, parse(BASE.replace('\n    <circle r="2"/>', "")));
    expect(r.removed).toEqual([before.circle]);
    expect(ids(r.tree).rect).toBe(before.rect);
    expect(ids(r.tree).text).toBe(before.text);
  });

  it("follows reordered siblings", () => {
    const swapped = BASE.replace('<rect x="1" fill="red"/>\n    <circle r="2"/>', '<circle r="2"/>\n    <rect x="1" fill="red"/>');
    expect(ids(reconcile(s.doc, parse(swapped)).tree)).toEqual(before);
  });

  it("follows an element cut and pasted into another parent", () => {
    const moved = BASE.replace('\n    <circle r="2"/>', "").replace('<path d="M0 0"/>', '<path d="M0 0"/>\n  <circle r="2"/>');
    expect(ids(reconcile(s.doc, parse(moved)).tree).circle).toBe(before.circle);
  });

  it("matches by id attribute even when the element moved and changed", () => {
    const moved = BASE.replace('<g id="layer">', '<g id="wrapper">\n  <g id="layer" opacity="0.5">').replace("</g>", "</g>\n  </g>");
    const r = reconcile(s.doc, parse(moved));
    const layer = r.tree.children[0]!.children[0]!;
    expect(layer.attrs.id).toBe("layer");
    expect(layer.id).toBe(before.g);
  });

  it("changing a tag gives a new ID", () => {
    const r = reconcile(s.doc, parse(BASE.replace('<path d="M0 0"/>', '<line x2="1"/>')));
    expect(ids(r.tree).line).toBeUndefined();
    expect(r.removed).toContain(before.path);
  });

  it("a total rewrite keeps only the root", () => {
    const r = reconcile(s.doc, parse(`<svg><ellipse/><polygon/></svg>`));
    expect(r.kept).toBe(1);
    expect(r.created).toBe(2);
  });
});
