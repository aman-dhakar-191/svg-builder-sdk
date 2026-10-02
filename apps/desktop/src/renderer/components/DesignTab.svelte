<script lang="ts">
  import AlignCenterHorizontal from "@lucide/svelte/icons/align-center-horizontal";
  import AlignCenterVertical from "@lucide/svelte/icons/align-center-vertical";
  import AlignEndHorizontal from "@lucide/svelte/icons/align-end-horizontal";
  import AlignEndVertical from "@lucide/svelte/icons/align-end-vertical";
  import AlignStartHorizontal from "@lucide/svelte/icons/align-start-horizontal";
  import AlignStartVertical from "@lucide/svelte/icons/align-start-vertical";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import SquaresExclude from "@lucide/svelte/icons/squares-exclude";
  import SquaresIntersect from "@lucide/svelte/icons/squares-intersect";
  import SquaresSubtract from "@lucide/svelte/icons/squares-subtract";
  import SquaresUnite from "@lucide/svelte/icons/squares-unite";
  import Waves from "@lucide/svelte/icons/waves";
  import X from "@lucide/svelte/icons/x";
  import { ANIMATION_TAGS, TEXT_TAG, type BBox, type NodeId } from "@svg-editor/sdk";
  import { slide } from "../lib/motion.js";
  import { agent } from "../lib/agent.svelte.js";
  import { session } from "../lib/session.svelte.js";
  import ColorField from "./ColorField.svelte";
  import MotionSection from "./MotionSection.svelte";
  import ScrubField from "./ScrubField.svelte";
  import Tip from "./Tip.svelte";

  const TEXT_HOSTS = ["text", "tspan", "title", "desc", "textPath"];

  // Everything below re-derives when the document or the selection changes.
  const doc = $derived.by(() => {
    void session.docVersion;
    return session.editor.doc;
  });
  const ids = $derived(session.selection.filter((id) => doc.has(id)));
  const node = $derived(ids.length === 1 ? doc.getNode(ids[0]!) : null);
  const box: BBox | null = $derived.by(() => {
    if (!node) return null;
    try {
      return doc.getBBox(node.id, "root");
    } catch {
      return null; // not measurable (e.g. empty group)
    }
  });
  const text = $derived.by(() => {
    if (!node || !TEXT_HOSTS.includes(node.tag)) return null;
    const kids = node.children.map((c) => doc.getNode(c)).filter((k) => !ANIMATION_TAGS.has(k.tag));
    return kids.every((k) => k.tag === TEXT_TAG) ? kids.map((k) => k.text ?? "").join("") : null;
  });
  /** Colours already used in the drawing, most used first: the palette to pick from. */
  const palette = $derived.by(() => {
    void session.docVersion;
    const count = new Map<string, number>();
    for (const id of doc.query()) {
      const a = doc.getNode(id).attrs;
      for (const v of [a.fill, a.stroke]) if (v && v !== "none" && !v.startsWith("url(")) count.set(v, (count.get(v) ?? 0) + 1);
    }
    return [...count.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([c]) => c);
  });
  const root = $derived.by(() => {
    void session.docVersion;
    return doc.getNode(doc.root);
  });
  const background = $derived.by(() => {
    void session.docVersion; // `doc` is the same object after a change
    return doc.getBackground();
  });
  function setBackground(v: string | null): void {
    session.guard(() => {
      try {
        doc.setBackground(v === null || v === "none" || v === "transparent" ? null : v);
      } catch (e) {
        session.showStatus(e instanceof Error ? e.message : String(e), true);
      }
    });
  }

  let showAll = $state(false);
  let newName = $state("");
  let newValue = $state("");

  function set(id: NodeId, attrs: Record<string, string | null>): void {
    if (session.recordAttrs(id, attrs)) return; // Record (timeline): a keyframe instead
    session.guard(() => {
      const r = session.editor.execute({ op: "set", id, attrs });
      if (!r.ok) session.showStatus(`${r.error.message} ${r.error.hint}`, true);
    });
  }
  function moveTo(axis: "x" | "y", v: number): void {
    if (!node || !box) return;
    const d: [number, number] = axis === "x" ? [v - box.x, 0] : [0, v - box.y];
    session.guard(() => {
      try {
        doc.translateInRoot(node.id, d);
      } catch (e) {
        session.showStatus(e instanceof Error ? e.message : String(e), true);
      }
    });
  }
  function setText(v: string): void {
    if (!node) return;
    const r = session.editor.execute({ op: "setText", id: node.id, text: v });
    if (!r.ok) session.showStatus(`${r.error.message} ${r.error.hint}`, true);
  }
  function askAgent(): void {
    if (!node) return;
    const name = node.attrs.id ? `"${node.attrs.id}"` : `selected <${node.tag}>`;
    agent.draft = `Change the ${name}: `;
    session.setMode("agent");
  }
  const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
</script>

{#snippet alignRow(disabled: boolean)}
  <div class="btns">
    {#each [["left", AlignStartVertical, "Align left"], ["center", AlignCenterVertical, "Align centres horizontally"], ["right", AlignEndVertical, "Align right"], ["top", AlignStartHorizontal, "Align top"], ["middle", AlignCenterHorizontal, "Align centres vertically"], ["bottom", AlignEndHorizontal, "Align bottom"]] as const as [edge, Icon, label]}
      <Tip text={label}><button class="icon-btn boxed" aria-label={label} {disabled} onclick={() => session.align(edge)}><Icon size={16} /></button></Tip>
    {/each}
  </div>
{/snippet}

{#snippet combineRow(n: number)}
  <div class="btns">
    <Tip text="Union"><button class="icon-btn boxed" aria-label="Union" disabled={n < 2} onclick={() => session.combine("union")}><SquaresUnite size={16} /></button></Tip>
    <Tip text="Subtract (bottom minus the others)"><button class="icon-btn boxed" aria-label="Subtract" disabled={n < 2} onclick={() => session.combine("subtract")}><SquaresSubtract size={16} /></button></Tip>
    <Tip text="Intersect"><button class="icon-btn boxed" aria-label="Intersect" disabled={n < 2} onclick={() => session.combine("intersect")}><SquaresIntersect size={16} /></button></Tip>
    <Tip text="Exclude"><button class="icon-btn boxed" aria-label="Exclude" disabled={n < 2} onclick={() => session.combine("exclude")}><SquaresExclude size={16} /></button></Tip>
    <Tip text="Simplify paths"><button class="icon-btn boxed" aria-label="Simplify" disabled={n < 1} onclick={() => session.simplify()}><Waves size={16} /></button></Tip>
  </div>
{/snippet}

{#if ids.length === 0}
  <section class="sec">
    <h3 class="eyebrow">Document</h3>
    <div class="grid2">
      <ScrubField label="W" value={num(root.attrs.width, session.editor.intrinsicSize().width)} min={1} title="Width" oncommit={(v) => set(root.id, { width: String(v) })} />
      <ScrubField label="H" value={num(root.attrs.height, session.editor.intrinsicSize().height)} min={1} title="Height" oncommit={(v) => set(root.id, { height: String(v) })} />
    </div>
    <label class="stack"><span class="hint">viewBox</span>
      <input class="input mono" value={root.attrs.viewBox ?? ""} placeholder="none" spellcheck="false" onchange={(e) => set(root.id, { viewBox: (e.target as HTMLInputElement).value.trim() || null })} />
    </label>
    <p class="hint">Select a shape to edit it. Double-click a path to move its points.</p>
  </section>
  <section class="sec" id="doc-background">
    <h3 class="eyebrow">Background</h3>
    <ColorField label="Background" value={background?.color ?? "none"} {palette} oncommit={setBackground} />
    <p class="hint">Behind the whole page. Export can leave it out for a transparent image.</p>
  </section>
{:else if ids.length > 1}
  <section class="sec">
    <h3 class="eyebrow">{ids.length} selected</h3>
    <p class="hint">Shift-click to add or remove shapes.</p>
  </section>
  <section class="sec"><h3 class="eyebrow">Align</h3>{@render alignRow(false)}</section>
  <section class="sec"><h3 class="eyebrow">Combine</h3>{@render combineRow(ids.length)}</section>
  <MotionSection {ids} />
{:else if node}
  <section class="sec">
    <h3 class="title"><span class="tag">&lt;{node.tag}&gt;</span>{#if node.attrs.id}<span class="idname">#{node.attrs.id}</span>{/if}</h3>
    <div class="grid2">
      <ScrubField label="X" value={box ? box.x : null} disabled={!box} title="Left edge, in drawing units" oncommit={(v) => moveTo("x", v)} />
      <ScrubField label="Y" value={box ? box.y : null} disabled={!box} title="Top edge, in drawing units" oncommit={(v) => moveTo("y", v)} />
      <ScrubField label="W" value={box ? box.width : null} disabled title="Width (resize with the handles on the canvas)" oncommit={() => {}} />
      <ScrubField label="H" value={box ? box.height : null} disabled title="Height (resize with the handles on the canvas)" oncommit={() => {}} />
    </div>
  </section>

  {#if session.nodeEditing}
    {@const pt = session.activeNode}
    <section class="sec points" transition:slide={{ duration: 160 }}>
      <h3 class="eyebrow">Point</h3>
      {#if pt}
        <div class="btns">
          <button class="btn small" aria-pressed={!pt.smooth} onclick={() => session.canvas?.nodeAction("corner")} title="Pull the handles in: a sharp point">Corner</button>
          <button class="btn small" aria-pressed={pt.smooth} onclick={() => session.canvas?.nodeAction("smooth")} title="Line the handles up: a smooth curve through the point">Smooth</button>
          <span class="spacer"></span>
          <button class="btn small ghost" onclick={() => session.canvas?.nodeAction("delete")} title="Remove this point (Delete)">Delete point</button>
        </div>
        {#if !pt.isStart}
          <span class="hint">Segment into this point</span>
          <div class="btns">
            <button class="btn small" onclick={() => session.canvas?.nodeAction("line")}>Straight line</button>
            <button class="btn small" onclick={() => session.canvas?.nodeAction("curve")}>Curve</button>
          </div>
        {/if}
      {:else}
        <p class="hint">Click a point to select it. Double-click the outline to add one; double-click a point to switch it between corner and smooth.</p>
      {/if}
    </section>
  {/if}

  {#if node.tag !== "g"}
    <section class="sec">
      <h3 class="eyebrow">Fill</h3>
      <ColorField label="Fill" value={node.attrs.fill} {palette} oncommit={(v) => set(node.id, { fill: v })} />
    </section>
    <section class="sec">
      <h3 class="eyebrow">Stroke</h3>
      <ColorField label="Stroke" value={node.attrs.stroke} {palette} oncommit={(v) => set(node.id, { stroke: v })} />
      <div class="grid2">
        <ScrubField label="W" value={num(node.attrs["stroke-width"], 1)} min={0} step={0.5} title="Stroke width" oncommit={(v) => set(node.id, { "stroke-width": String(v) })} />
      </div>
    </section>
  {/if}

  <section class="sec">
    <h3 class="eyebrow">Opacity <span class="val">{Math.round(num(node.attrs.opacity, 1) * 100)}%</span></h3>
    <input type="range" min="0" max="1" step="0.01" value={num(node.attrs.opacity, 1)} aria-label="Opacity"
      onchange={(e) => { const v = Number((e.target as HTMLInputElement).value); set(node.id, { opacity: v >= 1 ? null : String(v) }); }} />
  </section>

  {#if text !== null}
    <section class="sec">
      <h3 class="eyebrow">Text</h3>
      <textarea class="input area" rows="2" value={text} aria-label="Text content" onchange={(e) => setText((e.target as HTMLTextAreaElement).value)}></textarea>
    </section>
  {/if}

  <MotionSection {ids} />

  <section class="sec"><h3 class="eyebrow">Combine</h3>{@render combineRow(1)}<p class="hint">Select two or more shapes to combine them.</p></section>

  <section class="sec">
    <button class="btn ask" onclick={askAgent}><Sparkles size={15} />Ask the agent to change this</button>
  </section>

  <section class="sec all">
    <button class="disclose" aria-expanded={showAll} onclick={() => (showAll = !showAll)}><span class="chev" class:open={showAll}><ChevronRight size={14} /></span>All attributes <span class="count">{Object.keys(node.attrs).length}</span></button>
    {#if showAll}
      <div class="attrs" transition:slide={{ duration: 160 }}>
        {#each Object.entries(node.attrs) as [name, value] (name)}
          <div class="prop-row">
            <label for="prop-{name}" title={name}>{name}</label>
            <input id="prop-{name}" class="input mono" {value} spellcheck="false"
              onkeydown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") (e.target as HTMLInputElement).value = value; }}
              onchange={(e) => { const v = (e.target as HTMLInputElement).value; if (v !== value) set(node.id, { [name]: v }); }} />
            <button class="icon-btn" aria-label="Remove {name}" onclick={() => set(node.id, { [name]: null })}><X size={14} /></button>
          </div>
        {/each}
        <form class="prop-add" onsubmit={(e) => { e.preventDefault(); if (newName.trim()) { set(node.id, { [newName.trim()]: newValue }); newName = ""; newValue = ""; } }}>
          <input class="input mono" placeholder="attribute" aria-label="New attribute name" bind:value={newName} spellcheck="false" />
          <input class="input mono" placeholder="value" aria-label="New attribute value" bind:value={newValue} spellcheck="false" />
          <button class="btn small">Add</button>
        </form>
      </div>
    {/if}
  </section>
{/if}

<style>
  .sec { padding: 12px 14px; border-bottom: 1px solid var(--line); display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .sec h3 { margin: 0; display: flex; align-items: center; justify-content: space-between; }
  .title { font-size: 13px; font-weight: 600; gap: 8px; justify-content: flex-start !important; }
  .tag { font-family: var(--f-mono); }
  .idname { color: var(--muted); font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .val { font-variant-numeric: tabular-nums; font-weight: 500; letter-spacing: 0; text-transform: none; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .stack { display: grid; gap: 4px; }
  .mono { font-family: var(--f-mono); font-size: 12px; }
  .btns { display: flex; flex-wrap: wrap; gap: 4px; }
  .boxed { border: 1px solid var(--line); width: 34px; }
  .ask { justify-self: start; color: var(--warm); }
  .area { height: auto; padding: 6px 10px; resize: vertical; }
  input[type="range"] { width: 100%; accent-color: var(--ink); }
  .disclose { display: flex; align-items: center; gap: 6px; border: 0; background: none; padding: 0; color: var(--muted); font-weight: 500; }
  .disclose:hover { color: var(--fg); }
  .chev { display: inline-grid; transition: transform var(--fast) var(--ease); }
  .chev.open { transform: rotate(90deg); }
  .count { font-size: 11px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 999px; padding: 0 6px; }
  .attrs { display: grid; gap: 4px; }
  .prop-row { display: grid; grid-template-columns: 92px 1fr 30px; gap: 4px; align-items: center; }
  .prop-row label { font: 12px var(--f-mono); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prop-add { display: grid; grid-template-columns: 92px 1fr auto; gap: 4px; margin-top: 4px; }
</style>
