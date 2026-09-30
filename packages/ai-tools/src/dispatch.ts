import { SvgEditorError, TEXT_TAG, type BBox, type DocumentApi, type Editor, type NodeId, type PathMove, type TreeNode } from "@svg-editor/sdk";
import { TOOLS } from "./tools.js";
import { validate } from "./validate.js";

/** Where tool calls land: the lock session's doc (writes) and the editor (reads, selection). */
export interface ToolTarget {
  doc: DocumentApi;
  editor: Editor;
  /** Runs several writes as one unit (the lock session's batch). */
  batch<T>(fn: () => T): T;
  /** Snapshots still allowed this turn (render_snapshot); unlimited when absent. */
  snapshotBudget?: { left: number };
}

/** A PNG for the model to look at, base64-encoded. */
export interface ToolImage {
  mediaType: "image/png";
  data: string;
}

export type ToolOutcome =
  | { ok: true; result: unknown; image?: ToolImage }
  | { ok: false; error: { code: string; message: string; hint: string } };

/** Longest side of a snapshot, in pixels: small drawings are scaled up so the model sees detail. */
export const SNAPSHOT_MAX_SIZE = 1024;

const MAX_OUTLINE_NODES = 400;
const MAX_ATTR_CHARS = 120;

/**
 * Runs one tool call: validates the input against the tool's schema, then
 * calls the SDK. Never throws: every failure becomes a structured error the
 * model can read and correct from.
 */
export async function dispatch(target: ToolTarget, name: string, input: unknown): Promise<ToolOutcome> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return fail("UNKNOWN_TOOL", `There is no tool named "${name}".`, `Available tools: ${TOOLS.map((t) => t.name).join(", ")}.`);
  }
  const problem = validate(input ?? {}, tool.input_schema);
  if (problem) return fail("INVALID_INPUT", problem, `Call ${name} again with input that matches its schema.`);
  try {
    const value = await HANDLERS[name]!(target, (input ?? {}) as never);
    return value instanceof WithImage ? { ok: true, result: value.result, image: value.image } : { ok: true, result: value };
  } catch (e) {
    if (e instanceof SvgEditorError) {
      const j = e.toJSON();
      return fail(j.code, j.message, j.hint);
    }
    if (e instanceof ToolError) return fail(e.code, e.message, e.hint);
    return fail("INTERNAL", e instanceof Error ? e.message : String(e), "This is a bug in the editor; try a different approach.");
  }
}

function fail(code: string, message: string, hint: string): ToolOutcome {
  return { ok: false, error: { code, message, hint } };
}

/** Inputs are validated against the tool schema before a handler runs. */
type Handler = (t: ToolTarget, input: never) => unknown;

/** A tool-level failure that is not an SDK error (e.g. a per-turn limit). */
class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

class WithImage {
  constructor(
    readonly result: unknown,
    readonly image: ToolImage,
  ) {}
}

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
    let segments: unknown;
    if (n.tag === "path") {
      try {
        segments = t.doc.getPath(input.id);
      } catch {
        segments = undefined; // unreadable d: the attribute is still shown
      }
    }
    return {
      id: n.id,
      tag: n.tag,
      attributes: n.attrs,
      ...(text ? { text } : {}),
      ...(segments ? { segments } : {}),
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

  convert_to_path: (t, input: { ids: NodeId[] }) => ({ ids: t.batch(() => input.ids.map((i) => t.doc.convertToPath(i))) }),

  edit_path: (t, input: { id: NodeId; moves: PathMove[]; keep_handles?: boolean }) => ({
    id: input.id,
    d: t.doc.pathEdit(input.id, input.moves, input.keep_handles === undefined ? {} : { handles: input.keep_handles }),
  }),

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

  render_snapshot: async (t, input: { region?: BBox; ids?: NodeId[]; padding?: number }) => {
    if (t.snapshotBudget && t.snapshotBudget.left <= 0) {
      throw new ToolError("SNAPSHOT_LIMIT", "No snapshots are left for this turn.", "Finish with what you have and tell the user what to check.");
    }
    let region = input.region;
    if (!region && input.ids?.length) {
      const boxes = input.ids.map((i) => t.doc.getBBox(i, "root"));
      const x0 = Math.min(...boxes.map((b) => b.x));
      const y0 = Math.min(...boxes.map((b) => b.y));
      const x1 = Math.max(...boxes.map((b) => b.x + b.width));
      const y1 = Math.max(...boxes.map((b) => b.y + b.height));
      const pad = input.padding ?? Math.max(x1 - x0, y1 - y0, 1) * 0.1;
      region = { x: x0 - pad, y: y0 - pad, width: Math.max(x1 - x0, 1e-3) + 2 * pad, height: Math.max(y1 - y0, 1e-3) + 2 * pad };
    }
    const png = await t.editor.exportPng({ ...(region ? { region } : {}), longSide: SNAPSHOT_MAX_SIZE, background: "white" });
    if (t.snapshotBudget) t.snapshotBudget.left--;
    const size = pngSize(png);
    return new WithImage(
      { width: size.width, height: size.height, region: region ? round(region) : "whole page", note: "White background added for the snapshot; the drawing itself may be transparent." },
      { mediaType: "image/png", data: toBase64(png) },
    );
  },

  select_elements: (t, input: { ids: NodeId[] }) => {
    t.editor.select(input.ids);
    return { selection: t.editor.getSelection() };
  },
};

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? "=" : B64[c & 63]!;
  }
  return out;
}

function shortAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) out[k] = v.length > MAX_ATTR_CHARS ? `${v.slice(0, MAX_ATTR_CHARS)}… (${v.length} chars)` : v;
  return out;
}

function round(b: BBox): BBox {
  const r = (n: number) => Math.round(n * 100) / 100;
  return { x: r(b.x), y: r(b.y), width: r(b.width), height: r(b.height) };
}
