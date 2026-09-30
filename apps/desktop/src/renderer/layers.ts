import { TEXT_TAG, type Command, type NodeId, type SvgDocument, type TreeNode } from "@svg-editor/model";

/** Elements that can hold other elements (targets for "drop inside"). */
const CONTAINERS = new Set(["g", "svg", "a", "defs", "clipPath", "mask", "pattern", "symbol", "marker", "switch", "text", "textPath", "linearGradient", "radialGradient"]);

type Zone = "before" | "after" | "inside";

/**
 * Layers panel: the element tree in document order (same order as the code).
 * Click selects (Shift toggles); dragging a row onto another reorders or
 * reparents it with one `move` command.
 */
export class LayersPanel {
  private collapsed = new Set<NodeId>();
  private selection: NodeId[] = [];
  private dragging: NodeId | null = null;

  constructor(
    private readonly root: HTMLElement,
    private doc: SvgDocument,
    private readonly onSelect: (ids: NodeId[]) => void,
    private readonly onError: (message: string) => void,
  ) {}

  setDocument(doc: SvgDocument): void {
    this.doc = doc;
    this.collapsed.clear();
    this.render();
  }

  setSelection(ids: NodeId[]): void {
    this.selection = ids;
    for (const row of this.root.querySelectorAll<HTMLElement>(".layer-row")) {
      const on = ids.includes(row.dataset.id!);
      row.classList.toggle("selected", on);
      row.setAttribute("aria-selected", String(on));
    }
    const first = this.root.querySelector<HTMLElement>(".layer-row.selected");
    first?.scrollIntoView({ block: "nearest" });
  }

  render(): void {
    const tree = this.doc.getTree()!;
    const rows: HTMLElement[] = [];
    const walk = (n: TreeNode, depth: number) => {
      for (const c of n.children) {
        if (c.tag === TEXT_TAG) continue;
        rows.push(this.row(c, depth));
        if (!this.collapsed.has(c.id)) walk(c, depth + 1);
      }
    };
    walk(tree, 0);
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "panel-empty";
      empty.textContent = "No elements yet. Draw something or type in the code pane.";
      rows.push(empty);
    }
    this.root.replaceChildren(...rows);
    this.setSelection(this.selection.filter((id) => this.doc.getNode(id)));
  }

  private row(n: TreeNode, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "layer-row";
    row.dataset.id = n.id;
    row.setAttribute("role", "treeitem");
    row.draggable = true;
    row.style.paddingLeft = `${6 + depth * 14}px`;

    const hasKids = n.children.some((c) => c.tag !== TEXT_TAG);
    const twisty = document.createElement("button");
    twisty.className = "twisty";
    twisty.tabIndex = -1;
    twisty.textContent = hasKids ? (this.collapsed.has(n.id) ? "▸" : "▾") : "";
    twisty.disabled = !hasKids;
    twisty.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.collapsed.has(n.id)) this.collapsed.delete(n.id);
      else this.collapsed.add(n.id);
      this.render();
    });

    const tag = document.createElement("span");
    tag.className = "layer-tag";
    tag.textContent = n.tag;
    const label = document.createElement("span");
    label.className = "layer-label";
    label.textContent = describe(n);
    row.append(twisty, tag, label);

    row.addEventListener("click", (e) => {
      const ids = e.shiftKey
        ? this.selection.includes(n.id)
          ? this.selection.filter((s) => s !== n.id)
          : [...this.selection, n.id]
        : [n.id];
      this.onSelect(ids);
    });

    row.addEventListener("dragstart", (e) => {
      this.dragging = n.id;
      e.dataTransfer?.setData("text/plain", n.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      this.dragging = null;
      this.clearDropMarks();
    });
    row.addEventListener("dragover", (e) => {
      if (!this.dragging || this.dragging === n.id) return;
      e.preventDefault();
      this.clearDropMarks();
      row.classList.add(`drop-${zoneFor(e, row, CONTAINERS.has(n.tag))}`);
    });
    row.addEventListener("dragleave", () => this.clearDropMarks());
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const id = this.dragging ?? e.dataTransfer?.getData("text/plain");
      this.clearDropMarks();
      this.dragging = null;
      if (!id || id === n.id) return;
      const cmd = this.moveCommand(id, n.id, zoneFor(e, row, CONTAINERS.has(n.tag)));
      if (!cmd) return;
      const r = this.doc.execute(cmd);
      if (!r.ok) this.onError(`${r.error.message} ${r.error.hint}`);
      else this.onSelect([id]);
    });
    return row;
  }

  private clearDropMarks(): void {
    for (const r of this.root.querySelectorAll(".drop-before, .drop-after, .drop-inside")) {
      r.classList.remove("drop-before", "drop-after", "drop-inside");
    }
  }

  /** `move` uses the node's final index among the new parent's children. */
  private moveCommand(id: NodeId, target: NodeId, zone: Zone): Command | null {
    if (zone === "inside") {
      const kids = this.doc.getNode(target)!.children.filter((c) => c !== id);
      return { op: "move", id, parent: target, index: kids.length };
    }
    const parent = this.doc.getNode(target)!.parent;
    if (!parent) return null;
    const siblings = this.doc.getNode(parent)!.children.filter((c) => c !== id);
    const at = siblings.indexOf(target) + (zone === "after" ? 1 : 0);
    return { op: "move", id, parent, index: at };
  }
}

function zoneFor(e: DragEvent, row: HTMLElement, container: boolean): Zone {
  const box = row.getBoundingClientRect();
  const f = (e.clientY - box.top) / box.height;
  if (container) return f < 0.25 ? "before" : f > 0.75 ? "after" : "inside";
  return f < 0.5 ? "before" : "after";
}

/** Short label: id or Inkscape label, else text content. */
function describe(n: TreeNode): string {
  if (n.attrs["inkscape:label"]) return n.attrs["inkscape:label"];
  if (n.attrs.id) return `#${n.attrs.id}`;
  const text = n.children
    .filter((c) => c.tag === TEXT_TAG)
    .map((c) => c.text ?? "")
    .join("")
    .trim();
  return text ? `"${text.length > 24 ? `${text.slice(0, 24)}…` : text}"` : "";
}
