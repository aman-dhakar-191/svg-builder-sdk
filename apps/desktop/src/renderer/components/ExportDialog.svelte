<script lang="ts">
  import FileCode from "@lucide/svelte/icons/file-code";
  import FileImage from "@lucide/svelte/icons/file-image";
  import Minimize2 from "@lucide/svelte/icons/minimize-2";
  import { tick, untrack } from "svelte";
  import type { SvgExportStyle } from "../../shared/api.js";
  import { session } from "../lib/session.svelte.js";
  import Dialog from "./Dialog.svelte";

  const open = $derived(session.overlay === "export");

  // Sizes are measured when the dialog opens, so the user can see what minifying saves.
  let sizes: Record<SvgExportStyle, number> | null = $state(null);
  $effect(() => {
    if (!open) return;
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    sizes = untrack(() => ({ formatted: bytes(session.svgText("formatted")), minified: bytes(session.svgText("minified")) }));
  });

  function kb(n: number): string {
    return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  }
  async function choose(run: () => void): Promise<void> {
    session.overlay = null;
    await tick(); // let the dialog close and hand focus back before the save dialog opens
    run();
  }
</script>

<Dialog {open} label="Export" onclose={() => (session.overlay = null)}>
  <div class="export">
    <div>
      <h2>Export a copy</h2>
      <p class="lead">The open file stays as it is. Use Save to keep your own formatting.</p>
    </div>
    <div class="choices">
      <button data-export="png" onclick={() => choose(() => void session.exportPng())}>
        <FileImage size={18} /><strong>PNG image</strong><span>At the drawing's size</span>
      </button>
      <button data-export="formatted" onclick={() => choose(() => void session.exportSvg("formatted"))}>
        <FileCode size={18} /><strong>SVG, formatted</strong><span>One element per line, indented{#if sizes} · {kb(sizes.formatted)}{/if}</span>
      </button>
      <button data-export="minified" onclick={() => choose(() => void session.exportSvg("minified"))}>
        <Minimize2 size={18} /><strong>SVG, minified</strong><span>No whitespace between tags{#if sizes} · {kb(sizes.minified)}{/if}</span>
      </button>
    </div>
  </div>
</Dialog>

<style>
  .export { width: min(560px, 92vw); padding: 22px; display: grid; gap: 18px; }
  h2 { margin: 0; font-size: 17px; font-weight: 600; }
  .lead { margin: 6px 0 0; color: var(--muted); }
  .choices { display: grid; gap: 8px; }
  .choices button {
    display: grid; grid-template-columns: auto 1fr; column-gap: 12px; row-gap: 2px; align-items: center; text-align: left;
    border: 1px solid var(--line); background: var(--panel-2); border-radius: 12px; padding: 12px 14px;
    transition: border-color var(--fast), transform var(--fast), box-shadow var(--fast);
  }
  .choices button:hover, .choices button:focus-visible { border-color: var(--line-strong); transform: translateY(-1px); box-shadow: var(--shadow-sm); }
  .choices :global(svg) { grid-row: span 2; color: var(--ink); }
  strong { font-weight: 600; }
  span { font-size: 12px; color: var(--muted); }
</style>
