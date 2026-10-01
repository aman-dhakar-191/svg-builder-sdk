import { ANIMATION_TAGS } from "./animation.js";
import { TEXT_TAG, type NodeId, type SvgNode } from "./types.js";

/**
 * Elements whose whitespace is content. Pretty printing never indents inside
 * them (it would change the text), and the parser keeps their whitespace.
 */
export const TEXT_CONTAINERS: ReadonlySet<string> = new Set(["text", "tspan", "textPath", "title", "desc", "style", "script"]);

export interface SerializeOptions {
  /** Indent nested elements. Text containers and elements containing text stay on one line. */
  pretty?: boolean;
  /** Indent string for pretty output. Defaults to two spaces. */
  indent?: string;
  /** Leave out animation elements (<animate>, <animateTransform>, <animateMotion>, <set>): the drawing at rest. */
  static?: boolean;
}

export function escapeAttr(value: string, quote: '"' | "'" = '"'): string {
  let out = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  out = quote === '"' ? out.replace(/"/g, "&quot;") : out.replace(/'/g, "&apos;");
  // Parsers normalize raw tabs and newlines in attribute values to spaces.
  return out.replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
}

export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Basic model-to-text serializer, used for tests and headless output. The
 * editor's code pane does not use this for edits; it applies minimal patches.
 */
export function serialize(get: (id: NodeId) => SvgNode, root: NodeId, options: SerializeOptions = {}): string {
  const indent = options.indent ?? "  ";
  const kept = (c: NodeId) => !options.static || !ANIMATION_TAGS.has(get(c).tag);
  const write = (id: NodeId, depth: number, pretty: boolean): string => {
    const n = get(id);
    let children = n.children.filter(kept);
    // Only the indentation around removed animations left: an empty element.
    if (children.length < n.children.length && children.every((c) => get(c).tag === TEXT_TAG && !get(c).text?.trim())) children = [];
    if (n.tag === TEXT_TAG) return escapeText(n.text ?? "");
    const attrs = Object.entries(n.attrs)
      .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
      .join("");
    if (children.length === 0) return `<${n.tag}${attrs}/>`;
    const inline = TEXT_CONTAINERS.has(n.tag) || children.some((c) => get(c).tag === TEXT_TAG);
    if (!pretty || inline) {
      return `<${n.tag}${attrs}>${children.map((c) => write(c, 0, false)).join("")}</${n.tag}>`;
    }
    const pad = indent.repeat(depth + 1);
    const inner = children.map((c) => pad + write(c, depth + 1, true)).join("\n");
    return `<${n.tag}${attrs}>\n${inner}\n${indent.repeat(depth)}</${n.tag}>`;
  };
  return write(root, 0, options.pretty ?? false);
}
