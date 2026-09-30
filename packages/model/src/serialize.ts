import { TEXT_TAG, type NodeId, type SvgNode } from "./types.js";

export interface SerializeOptions {
  /** Indent nested elements. Elements containing text are kept on one line so text is unchanged. */
  pretty?: boolean;
  /** Indent string for pretty output. Defaults to two spaces. */
  indent?: string;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Basic model-to-text serializer, used for tests and headless output. The
 * editor's code pane does not use this for edits; it applies minimal patches.
 */
export function serialize(get: (id: NodeId) => SvgNode, root: NodeId, options: SerializeOptions = {}): string {
  const indent = options.indent ?? "  ";
  const write = (id: NodeId, depth: number, pretty: boolean): string => {
    const n = get(id);
    if (n.tag === TEXT_TAG) return escapeText(n.text ?? "");
    const attrs = Object.entries(n.attrs)
      .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
      .join("");
    if (n.children.length === 0) return `<${n.tag}${attrs}/>`;
    const hasText = n.children.some((c) => get(c).tag === TEXT_TAG);
    if (!pretty || hasText) {
      return `<${n.tag}${attrs}>${n.children.map((c) => write(c, 0, false)).join("")}</${n.tag}>`;
    }
    const pad = indent.repeat(depth + 1);
    const inner = n.children.map((c) => pad + write(c, depth + 1, true)).join("\n");
    return `<${n.tag}${attrs}>\n${inner}\n${indent.repeat(depth)}</${n.tag}>`;
  };
  return write(root, 0, options.pretty ?? false);
}
