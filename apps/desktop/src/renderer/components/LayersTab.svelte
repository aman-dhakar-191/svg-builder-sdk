<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Circle from "@lucide/svelte/icons/circle";
  import Eye from "@lucide/svelte/icons/eye";
  import EyeOff from "@lucide/svelte/icons/eye-off";
  import Folder from "@lucide/svelte/icons/folder";
  import Minus from "@lucide/svelte/icons/minus";
  import Spline from "@lucide/svelte/icons/spline";
  import Square from "@lucide/svelte/icons/square";
  import Shapes from "@lucide/svelte/icons/shapes";
  import Type from "@lucide/svelte/icons/type";
  import { TEXT_TAG, type Command, type NodeId, type TreeNode } from "@svg-editor/sdk";
  import { session } from "../lib/session.svelte.js";

  /** Elements that can hold other elements (targets for "drop inside"). */
  const CONTAINERS = new Set(["g", "svg", "a", "defs", "clipPath", "mask", "pattern", "symbol", "marker", "switch", "text", "textPath", "linearGradient", "radialGradient"]);
  const ICONS: Record<string, typeof Square> = { g: Folder, rect: Square, circle: Circle, ellipse: Circle, line: Minus, polyline: Spline, polygon: Shapes, path: Spline, text: Type, tspan: Type, textPath: Type };
  type Zone = "before" | "after" | "inside";

  let collapsed = $state(new Set<NodeId>());
  let dragging: NodeId | null = null;
  let drop: { id: NodeId; zone: Zone } | null = $state(null);

  const rows = $derived.by(() => {
    void session.docVersion;
    const out: { n: TreeNode; depth: number; hasKids: boolean }[] = [];
    const walk = (n: TreeNode, depth: number) => {
      for (const c of n.children) {
        if (c.tag === TEXT_TAG) continue;
        const hasKids = c.children.some((k) => k.tag !== TEXT_TAG);
        out.push({ n: c, depth, hasKids });
        if (!collapsed.has(c.id)) walk(c, depth + 1);
      }
    };
    walk(session.editor.doc.getTree(), 0);
    return out;
  });
  const selected = $derived(new Set(session.selection));

  // Keep the selected row in view when the selection comes from the canvas or code.
  let list: HTMLElement;
  $effect(() => {
    void session.selection;
    queueMicrotask(() => list?.querySelector(".layer-row.selected")?.scrollIntoView({ block: "nearest" }));
  });

  function toggleCollapse(id: NodeId): void {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }
  function click(e: MouseEvent, id: NodeId): void {
    const sel = session.selection;
    session.editor.select(e.shiftKey ? (sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]) : [id]);
  }
  function toggleHidden(n: TreeNode): void {
    const r = session.editor.execute({ op: "set", id: n.id, attrs: { display: n.attrs.display === "none" ? null : "none" } });
    if (!r.ok) session.showStatus(`${r.error.message} ${r.error.hint}`, true);
  }
  function zoneFor(e: DragEvent, row: HTMLElement, container: boolean): Zone {
    const box = row.getBoundingClientRect();
    const f = (e.clientY - box.top) / box.height;
    if (container) return f < 0.25 ? "before" : f > 0.75 ? "after" : "inside";
    return f < 0.5 ? "before" : "after";
  }
  /** `move` uses the node's final index among the new parent's children. */
  function moveCommand(id: NodeId, target: NodeId, zone: Zone): Command | null {
    const doc = session.editor.doc;
    if (zone === "inside") return { op: "move", id, parent: target, index: doc.getNode(target).children.filter((c) => c !== id).length };
    const parent = doc.getNode(target).parent;
    if (!parent) return null;
    const siblings = doc.getNode(parent).children.filter((c) => c !== id);
    return { op: "move", id, parent, index: siblings.indexOf(target) + (zone === "after" ? 1 : 0) };
  }
  function onDrop(e: DragEvent, target: TreeNode): void {
    e.preventDefault();
    const id = dragging ?? e.dataTransfer?.getData("text/plain");
    const zone = drop?.zone;
    drop = null;
    dragging = null;
    if (!id || id === target.id || !zone) return;
    const cmd = moveCommand(id, target.id, zone);
    if (!cmd) return;
    const r = session.editor.execute(cmd);
    if (!r.ok) session.showStatus(`${r.error.message} ${r.error.hint}`, true);
    else session.editor.select([id]);
  }
  /** Short label: Inkscape label or id, else text content. */
  function describe(n: TreeNode): string {
    if (n.attrs["inkscape:label"]) return n.attrs["inkscape:label"];
    if (n.attrs.id) return `#${n.attrs.id}`;
    const t = n.children.filter((c) => c.tag === TEXT_TAG).map((c) => c.text ?? "").join("").trim();
    return t ? `"${t.length > 24 ? `${t.slice(0, 24)}…` : t}"` : "";
  }
</script>

<div id="layers" role="tree" aria-label="Layers" bind:this={list}>
  {#each rows as { n, depth, hasKids } (n.id)}
    {@const Icon = ICONS[n.tag] ?? Shapes}
    <div
      class="layer-row"
      class:selected={selected.has(n.id)}
      class:hidden-el={n.attrs.display === "none"}
      class:drop-before={drop?.id === n.id && drop.zone === "before"}
      class:drop-after={drop?.id === n.id && drop.zone === "after"}
      class:drop-inside={drop?.id === n.id && drop.zone === "inside"}
      role="treeitem"
      aria-selected={selected.has(n.id)}
      aria-expanded={hasKids ? !collapsed.has(n.id) : undefined}
      tabindex="-1"
      data-id={n.id}
      draggable="true"
      style:padding-left="{6 + depth * 14}px"
      onclick={(e) => click(e, n.id)}
      onkeydown={(e) => { if (e.key === "Enter") click(e as unknown as MouseEvent, n.id); }}
      ondragstart={(e) => { dragging = n.id; e.dataTransfer?.setData("text/plain", n.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; }}
      ondragend={() => { dragging = null; drop = null; }}
      ondragover={(e) => { if (!dragging || dragging === n.id) return; e.preventDefault(); drop = { id: n.id, zone: zoneFor(e, e.currentTarget as HTMLElement, CONTAINERS.has(n.tag)) }; }}
      ondragleave={() => { if (drop?.id === n.id) drop = null; }}
      ondrop={(e) => onDrop(e, n)}
    >
      <button class="twisty" tabindex="-1" disabled={!hasKids} aria-label={collapsed.has(n.id) ? "Expand" : "Collapse"} onclick={(e) => { e.stopPropagation(); toggleCollapse(n.id); }}>
        {#if hasKids}<span class="chev" class:open={!collapsed.has(n.id)}><ChevronRight size={13} /></span>{/if}
      </button>
      <span class="ico"><Icon size={14} /></span>
      <span class="layer-tag">{n.tag}</span>
      <span class="layer-label">{describe(n)}</span>
      <button class="vis" aria-label={n.attrs.display === "none" ? "Show" : "Hide"} title={n.attrs.display === "none" ? "Show" : "Hide"} onclick={(e) => { e.stopPropagation(); toggleHidden(n); }}>
        {#if n.attrs.display === "none"}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
      </button>
    </div>
  {:else}
    <p class="empty">No shapes yet. Draw one with the tools on the left, type in the code, or ask the agent.</p>
  {/each}
</div>

<style>
  #layers { padding: 6px; display: grid; gap: 1px; }
  .layer-row { display: flex; align-items: center; gap: 6px; height: 28px; padding-right: 4px; border-radius: 7px; cursor: default; white-space: nowrap; transition: background var(--fast); }
  .layer-row:hover { background: var(--hover); }
  .layer-row.selected { background: var(--ink-soft); }
  .layer-row.hidden-el .layer-tag, .layer-row.hidden-el .layer-label, .layer-row.hidden-el .ico { opacity: 0.45; }
  .layer-row.drop-before { box-shadow: inset 0 2px 0 var(--ink); }
  .layer-row.drop-after { box-shadow: inset 0 -2px 0 var(--ink); }
  .layer-row.drop-inside { outline: 1.5px solid var(--ink); outline-offset: -1.5px; }
  .twisty { width: 16px; height: 16px; border: 0; background: none; color: var(--muted); padding: 0; display: grid; place-items: center; flex: none; }
  .chev { display: inline-grid; transition: transform var(--fast) var(--ease); }
  .chev.open { transform: rotate(90deg); }
  .ico { color: var(--muted); display: inline-grid; flex: none; }
  .layer-tag { font: 12px var(--f-mono); }
  .layer-label { color: var(--muted); overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .vis { opacity: 0; border: 0; background: none; color: var(--muted); width: 24px; height: 24px; border-radius: 5px; display: grid; place-items: center; transition: opacity var(--fast); flex: none; }
  .layer-row:hover .vis, .layer-row.hidden-el .vis, .vis:focus-visible { opacity: 1; }
  .vis:hover { background: var(--panel); color: var(--fg); }
  .empty { color: var(--muted); padding: 8px; margin: 0; }
</style>
