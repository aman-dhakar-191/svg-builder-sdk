<script lang="ts">
  import Circle from "@lucide/svelte/icons/circle";
  import Hand from "@lucide/svelte/icons/hand";
  import Minus from "@lucide/svelte/icons/minus";
  import MousePointer2 from "@lucide/svelte/icons/mouse-pointer-2";
  import Spline from "@lucide/svelte/icons/spline";
  import Square from "@lucide/svelte/icons/square";
  import Type from "@lucide/svelte/icons/type";
  import type { Tool } from "../canvas.js";
  import { session } from "../lib/session.svelte.js";
  import Tip from "./Tip.svelte";

  const TOOLS: { tool: Tool; label: string; key: string; icon: typeof Square }[] = [
    { tool: "select", label: "Select", key: "V", icon: MousePointer2 },
    { tool: "rect", label: "Rectangle", key: "R", icon: Square },
    { tool: "ellipse", label: "Ellipse", key: "E", icon: Circle },
    { tool: "line", label: "Line", key: "L", icon: Minus },
    { tool: "text", label: "Text", key: "T", icon: Type },
  ];
  const locked = $derived(session.lock !== null);
</script>

<nav class="rail" aria-label="Tools">
  {#each TOOLS as t, i}
    {#if i === 1}<hr />{/if}
    <Tip text={t.label} keys={t.key} side="right">
      <button class="tool" data-tool={t.tool} aria-label={t.label} aria-pressed={session.tool === t.tool && !session.nodeEditing} disabled={locked} onclick={() => session.canvas?.setTool(t.tool)}>
        <t.icon size={17} />
      </button>
    </Tip>
  {/each}
  <hr />
  <Tip text="Edit path nodes" keys="Enter" side="right">
    <button class="tool" aria-label="Edit path nodes" aria-pressed={session.nodeEditing} disabled={locked} onclick={() => (session.nodeEditing ? session.canvas?.exitNodeEdit() : session.editNodes())}>
      <Spline size={17} />
    </button>
  </Tip>
  <span class="spacer"></span>
  <Tip text="Pan: hold Space and drag" side="right">
    <span class="tool passive" aria-hidden="true"><Hand size={17} /></span>
  </Tip>
</nav>

<style>
  .rail { grid-area: rail; background: var(--panel); border-right: 1px solid var(--line); display: flex; flex-direction: column; align-items: center; gap: 2px; padding-block: 8px; }
  hr { width: 24px; border: 0; border-top: 1px solid var(--line); margin: 6px 0; }
  .tool { width: 36px; height: 36px; display: grid; place-items: center; border: 0; background: none; border-radius: 9px; color: var(--muted); transition: background var(--fast), color var(--fast), transform var(--fast); }
  .tool:hover:not(:disabled) { background: var(--hover); color: var(--fg); }
  .tool:active:not(:disabled) { transform: scale(0.94); }
  .tool[aria-pressed="true"] { background: var(--ink-soft); color: var(--ink); }
  .tool:disabled { opacity: 0.4; }
  .passive { opacity: 0.6; }
</style>
