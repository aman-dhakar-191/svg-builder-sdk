import { SvgEditorError, TEXT_TAG, type BBox, type DocumentApi, type Editor, type NodeId, type TreeNode } from "@svg-editor/sdk";
import { TOOLS } from "./tools.js";
import { validate } from "./validate.js";

/** Where tool calls land: the lock session's doc (writes) and the editor (reads, selection). */
export interface ToolTarget {
  doc: DocumentApi;
  editor: Editor;
  /** Runs several writes as one unit (the lock session's batch). */
  batch<T>(fn: () => T): T;
}

export type ToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; hint: string } };

const MAX_OUTLINE_NODES = 400;
const MAX_ATTR_CHARS = 120;

/**
 * Runs one tool call: validates the input against the tool's schema, then
 * calls the SDK. Never throws: every failure becomes a structured error the
 * model can read and correct from.
 */
export function dispatch(target: ToolTarget, name: string, input: unknown): ToolOutcome {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return fail("UNKNOWN_TOOL", `There is no tool named "${name}".`, `Available tools: ${TOOLS.map((t) => t.name).join(", ")}.`);
  }
  const problem = validate(input ?? {}, tool.input_schema);
  if (problem) return fail("INVALID_INPUT", problem, `Call ${name} again with input that matches its schema.`);
  try {
    return { ok: true, result: HANDLERS[name]!(target, (input ?? {}) as never) };
  } catch (e) {
    if (e instanceof SvgEditorError) {
      const j = e.toJSON();
      return fail(j.code, j.message, j.hint);
    }
    return fail("INTERNAL", e instanceof Error ? e.message : String(e), "This is a bug in the editor; try a different approach.");
  }
}

function fail(code: string, message: string, hint: string): ToolOutcome {
  return { ok: false, error: { code, message, hint } };
}

/** Inputs are validated against the tool schema before a handler runs. */
type Handler = (t: ToolTarget, input: never) => unknown;

const HANDLERS: Record<string, Handler> = {
  get_document: (t) => {
    const doc = t.doc;
    const root = doc.getNode(doc.root);
    let count = 0;
    let truncated = false;
    const outline = (n: TreeNode): unknown => {
      count++;
      const kids: unknown[] = [];
      let text = "";
      for (const c of n.children) {
        if (c.tag === TEXT_TAG) text += c.text ?? "";
        else if (count < MAX_OUTLINE_NODES) kids.push(outline(c));
        else truncated = true;
      }
      return { id: n.id, tag: n.tag, attributes: shortAttrs(n.attrs), ...(text ? { text } : {}), ...(kids.length ? { children: kids } : {}) };
    };
    const tree = doc.getTree();
    return {
      viewBox: root.attrs.viewBox ?? null,
      size: t.editor.intrinsicSize(),
      selection: t.editor.getSelection(),
      element_count: doc.query().length - 1,
      outline: tree.children.filter((c) => c.tag !== TEXT_TAG).map(outline),
      ...(truncated ? { truncated: `Only the first ${MAX_OUTLINE_NODES} elements are listed; use query_elements for the rest.` } : {}),
    };
  },

  query_elements: (t, input: { tag?: string; attributes?: Record<string, string | boolean> }) => {
    const attr: Record<string, string | true> = {};
    for (const [k, v] of Object.entries(input.attributes ?? {})) {
      if (v === false) continue;
      attr[k] = v === true ? true : v;
    }
    const found = t.doc.query({ ...(input.tag ? { tag: input.tag } : {}), attr }).filter((i) => i !== t.doc.root);
    return {
      count: found.length,
      elements: found.slice(0, 200).map((i) => {
        const n = t.doc.getNode(i);
        return { id: i, tag: n.tag, attributes: shortAttrs(n.attrs) };
      }),
    };
  },

  get_element: (t, input: { id: NodeId }) => {
    const n = t.doc.getNode(input.id);
    const text = n.children.map((c) => t.doc.getNode(c)).filter((c) => c.tag === TEXT_TAG).map((c) => c.text).join("");
    let bbox: BBox | null = null;
    try {
      bbox = round(t.doc.getBBox(input.id, "root"));
    } catch {
      bbox = null;
    }
    return {
      id: n.id,
      tag: n.tag,
      attributes: n.attrs,
      ...(text ? { text } : {}),
      parent: n.parent,
      children: n.children.filter((c) => t.doc.getNode(c).tag !== TEXT_TAG),
      bbox,
    };
  },

  add_elements: (t, input: { elements: { tag: string; attributes?: Record<string, string | number>; text?: string; parent?: string; index?: number }[] }) => {
    const created: NodeId[] = [];
    const resolve = (ref: string | undefined, i: number): NodeId | undefined => {
      if (ref === undefined) return undefined;
      const m = /^\$(\d+)$/.exec(ref);
      if (!m) return ref;
      const n = Number(m[1]);
      if (n >= i) throw new SvgEditorError("INVALID_COMMAND", `elements[${i}].parent "${ref}" refers to an element that is not created yet.`, 'Use "$N" only for elements earlier in the list.');
      return created[n];
    };
    t.batch(() => {
      input.elements.forEach((el, i) => {
        const at = { ...(el.parent !== undefined ? { parent: resolve(el.parent, i)! } : {}), ...(el.index !== undefined ? { index: el.index } : {}) };
        try {
          const newId = t.doc.add(el.tag, el.attributes ?? {}, at);
          if (el.text !== undefined) t.doc.setText(newId, el.text);
          created.push(newId);
        } catch (e) {
          if (e instanceof SvgEditorError) throw new SvgEditorError(e.code, `elements[${i}] (<${el.tag}>): ${e.message} Nothing was added.`, e.hint);
          throw e;
        }
      });
    });
    return { ids: created };
  },

  set_attributes: (t, input: { id: NodeId; attributes: Record<string, string | number | null> }) => {
    t.doc.set(input.id, input.attributes);
    return { id: input.id, attributes: t.doc.getNode(input.id).attrs };
  },

  delete_elements: (t, input: { ids: NodeId[] }) => {
    t.doc.delete(input.ids);
    return { deleted: input.ids };
  },

  move_element: (t, input: { id: NodeId; parent: NodeId; index: number }) => {
    t.doc.move(input.id, input.parent, input.index);
    return { id: input.id, parent: input.parent, index: t.doc.getNode(input.parent).children.indexOf(input.id) };
  },

  group_elements: (t, input: { ids: NodeId[] }) => ({ id: t.doc.group(input.ids) }),

  ungroup_element: (t, input: { id: NodeId }) => ({ ids: t.doc.ungroup(input.id) }),

  transform_element: (t, input: { id: NodeId; translate?: [number, number]; scale?: number | [number, number]; rotate?: number; origin?: "center" | [number, number] }) => {
    const transform = t.doc.transform(input.id, {
      ...(input.translate ? { translate: input.translate } : {}),
      ...(input.scale !== undefined ? { scale: input.scale } : {}),
      ...(input.rotate !== undefined ? { rotate: input.rotate } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    });
    return { id: input.id, transform };
  },

  set_text: (t, input: { id: NodeId; text: string }) => {
    t.doc.setText(input.id, input.text);
    return { id: input.id };
  },

  align_elements: (t, input: { ids: NodeId[]; edge: "left" | "right" | "top" | "bottom" | "center" | "middle" }) => {
    const boxes = input.ids.map((i) => ({ id: i, b: t.doc.getBBox(i, "root") }));
    const minX = Math.min(...boxes.map((x) => x.b.x));
    const maxX = Math.max(...boxes.map((x) => x.b.x + x.b.width));
    const minY = Math.min(...boxes.map((x) => x.b.y));
    const maxY = Math.max(...boxes.map((x) => x.b.y + x.b.height));
    t.batch(() => {
      for (const { id: i, b } of boxes) {
        const dx = input.edge === "left" ? minX - b.x : input.edge === "right" ? maxX - (b.x + b.width) : input.edge === "center" ? (minX + maxX) / 2 - (b.x + b.width / 2) : 0;
        const dy = input.edge === "top" ? minY - b.y : input.edge === "bottom" ? maxY - (b.y + b.height) : input.edge === "middle" ? (minY + maxY) / 2 - (b.y + b.height / 2) : 0;
        if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) t.doc.translateInRoot(i, [dx, dy]);
      }
    });
    return { aligned: input.ids, edge: input.edge };
  },

  distribute_elements: (t, input: { ids: NodeId[]; axis: "horizontal" | "vertical" }) => {
    const h = input.axis === "horizontal";
    const items = input.ids
      .map((i) => {
        const b = t.doc.getBBox(i, "root");
        return { id: i, c: h ? b.x + b.width / 2 : b.y + b.height / 2 };
      })
      .sort((a, b) => a.c - b.c);
    const first = items[0]!.c;
    const step = (items[items.length - 1]!.c - first) / (items.length - 1);
    t.batch(() => {
      items.forEach((it, k) => {
        const d = first + step * k - it.c;
        if (Math.abs(d) > 1e-9) t.doc.translateInRoot(it.id, h ? [d, 0] : [0, d]);
      });
    });
    return { distributed: items.map((i) => i.id), axis: input.axis };
  },

  select_elements: (t, input: { ids: NodeId[] }) => {
    t.editor.select(input.ids);
    return { selection: t.editor.getSelection() };
  },
};

function shortAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) out[k] = v.length > MAX_ATTR_CHARS ? `${v.slice(0, MAX_ATTR_CHARS)}… (${v.length} chars)` : v;
  return out;
}

function round(b: BBox): BBox {
  const r = (n: number) => Math.round(n * 100) / 100;
  return { x: r(b.x), y: r(b.y), width: r(b.width), height: r(b.height) };
}
