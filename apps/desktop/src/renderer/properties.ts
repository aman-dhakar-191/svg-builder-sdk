import { TEXT_TAG, type NodeId, type SvgDocument } from "@svg-editor/model";

/**
 * Properties panel: the selected element's attributes, editable in place.
 * Enter or leaving a field sends one `set` command (value "" keeps an empty
 * attribute; the × button removes it). Text-only elements also get a text field
 * (`setText`).
 */
export class PropertiesPanel {
  private selection: NodeId[] = [];

  constructor(
    private readonly root: HTMLElement,
    private doc: SvgDocument,
    private readonly onError: (message: string) => void,
  ) {}

  setDocument(doc: SvgDocument): void {
    this.doc = doc;
    this.selection = [];
    this.render();
  }

  setSelection(ids: NodeId[]): void {
    this.selection = ids;
    this.render();
  }

  render(): void {
    const focused = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement) ? document.activeElement.dataset.field : undefined;
    const ids = this.selection.filter((id) => this.doc.getNode(id));
    if (ids.length !== 1) {
      const p = document.createElement("p");
      p.className = "panel-empty";
      p.textContent = ids.length === 0 ? "Select an element to edit its attributes." : `${ids.length} elements selected. Select one to edit its attributes.`;
      this.root.replaceChildren(p);
      return;
    }
    const id = ids[0]!;
    const node = this.doc.getNode(id)!;
    const children: HTMLElement[] = [];

    const title = document.createElement("div");
    title.className = "props-title";
    title.textContent = `<${node.tag}>`;
    children.push(title);

    for (const [name, value] of Object.entries(node.attrs)) {
      const row = document.createElement("div");
      row.className = "prop-row";
      const label = document.createElement("label");
      label.textContent = name;
      label.title = name;
      const input = document.createElement("input");
      input.value = value;
      input.dataset.field = `attr:${name}`;
      input.setAttribute("aria-label", name);
      label.htmlFor = input.id = `prop-${name.replace(/[^\w-]/g, "_")}`;
      const commit = () => {
        if (input.value !== this.doc.getNode(id)?.attrs[name]) this.set(id, { [name]: input.value });
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") input.value = value;
      });
      input.addEventListener("change", commit);
      const remove = document.createElement("button");
      remove.className = "prop-remove";
      remove.textContent = "×";
      remove.title = `Remove ${name}`;
      remove.addEventListener("click", () => this.set(id, { [name]: null }));
      row.append(label, input, remove);
      children.push(row);
    }

    // Add attribute
    const add = document.createElement("form");
    add.className = "prop-add";
    const nameIn = document.createElement("input");
    nameIn.placeholder = "attribute";
    nameIn.dataset.field = "new-name";
    nameIn.setAttribute("aria-label", "New attribute name");
    const valueIn = document.createElement("input");
    valueIn.placeholder = "value";
    valueIn.dataset.field = "new-value";
    valueIn.setAttribute("aria-label", "New attribute value");
    const addBtn = document.createElement("button");
    addBtn.textContent = "Add";
    add.append(nameIn, valueIn, addBtn);
    add.addEventListener("submit", (e) => {
      e.preventDefault();
      if (nameIn.value.trim()) this.set(id, { [nameIn.value.trim()]: valueIn.value });
    });
    children.push(add);

    // Text content for elements that hold only text.
    const kids = node.children.map((c) => this.doc.getNode(c)!);
    if (kids.every((k) => k.tag === TEXT_TAG) && ["text", "tspan", "title", "desc", "textPath"].includes(node.tag)) {
      const text = kids.map((k) => k.text ?? "").join("");
      const label = document.createElement("label");
      label.className = "prop-text-label";
      label.textContent = "Text";
      const area = document.createElement("textarea");
      area.value = text;
      area.rows = 2;
      area.dataset.field = "text";
      area.setAttribute("aria-label", "Text content");
      area.addEventListener("change", () => {
        const r = this.doc.execute({ op: "setText", id, text: area.value });
        if (!r.ok) this.onError(`${r.error.message} ${r.error.hint}`);
      });
      children.push(label, area);
    }

    this.root.replaceChildren(...children);
    if (focused) this.root.querySelector<HTMLElement>(`[data-field="${CSS.escape(focused)}"]`)?.focus();
  }

  private set(id: NodeId, attrs: Record<string, string | null>): void {
    const r = this.doc.execute({ op: "set", id, attrs });
    if (!r.ok) this.onError(`${r.error.message} ${r.error.hint}`);
  }
}
