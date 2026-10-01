import { TEXT_TAG, type NodeId, type TreeNode } from "@svg-editor/sdk";

const SVG_NS = "http://www.w3.org/2000/svg";
const KNOWN_NS: Record<string, string> = {
  xlink: "http://www.w3.org/1999/xlink",
  xml: "http://www.w3.org/XML/1998/namespace",
};

export interface Rendered {
  svg: SVGSVGElement;
  /** DOM element -> model node, for hit-testing in step 4. No attributes are added to the SVG. */
  nodeOf: WeakMap<Element, NodeId>;
  /** Model node -> its DOM element or text node (skipped nodes are absent), for patching in place. */
  domOf: Map<NodeId, Element | Text>;
  /** Namespace prefixes declared on the root, for patching attributes later. */
  ns: Record<string, string>;
}

/** Whether a node is left out of the canvas (scripts, foreign-namespace elements). */
export function skipped(tag: string): boolean {
  return tag === "script" || tag.includes(":");
}

/**
 * Sets an element's attributes to `attrs`, removing the others, with the same
 * safety rules as the first render: no event handlers, no javascript: links.
 */
export function applyAttrs(el: Element, attrs: Record<string, string>, ns: Record<string, string>): void {
  const keep = new Set<string>();
  for (const [name, value] of Object.entries(attrs)) {
    if (/^on/i.test(name) || name === "xmlns" || name.startsWith("xmlns:")) continue;
    if ((name === "href" || name === "xlink:href") && /^\s*javascript:/i.test(value)) continue;
    const colon = name.indexOf(":");
    const prefixNs = colon > 0 ? ns[name.slice(0, colon)] : undefined;
    try {
      if (prefixNs) el.setAttributeNS(prefixNs, name, value);
      else if (colon < 0) el.setAttribute(name, value);
      else continue; // attributes in unknown namespaces (editor metadata) do not affect rendering
      keep.add(name);
    } catch {
      // Invalid attribute for the DOM: skip it rather than fail the render.
    }
  }
  for (const a of Array.from(el.attributes)) if (!keep.has(a.name)) el.removeAttributeNS(a.namespaceURI, a.localName);
}

/**
 * Builds live DOM from the model tree (never from raw text), so what is shown
 * is exactly what the model holds. User SVG is untrusted: scripts, event
 * handler attributes and javascript: links are dropped (the page CSP also
 * blocks inline script), and non-SVG elements from other namespaces are skipped.
 */
export function renderTree(tree: TreeNode, doc: Document = document): Rendered {
  const nodeOf = new WeakMap<Element, NodeId>();
  const domOf = new Map<NodeId, Element | Text>();
  const ns: Record<string, string> = { ...KNOWN_NS };
  for (const [k, v] of Object.entries(tree.attrs)) if (k.startsWith("xmlns:")) ns[k.slice(6)] = v;

  const build = (n: TreeNode): Node | null => {
    if (n.tag === TEXT_TAG) {
      const t = doc.createTextNode(n.text ?? "");
      domOf.set(n.id, t);
      return t;
    }
    if (skipped(n.tag)) return null;
    const el = doc.createElementNS(SVG_NS, n.tag);
    applyAttrs(el, n.attrs, ns);
    nodeOf.set(el, n.id);
    domOf.set(n.id, el);
    for (const c of n.children) {
      const child = build(c);
      if (child) el.appendChild(child);
    }
    return el;
  };

  const svg = build(tree) as SVGSVGElement;
  return { svg, nodeOf, domOf, ns };
}
