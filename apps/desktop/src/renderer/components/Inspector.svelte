<script lang="ts">
  import { session } from "../lib/session.svelte.js";
  import DesignTab from "./DesignTab.svelte";
  import LayersTab from "./LayersTab.svelte";

  let tab: "design" | "layers" = $state("design");
</script>

<aside class="inspector" aria-label="Inspector">
  <div class="tabs" role="tablist">
    <button role="tab" id="tab-design-button" aria-selected={tab === "design"} onclick={() => (tab = "design")}>Design</button>
    <button role="tab" id="tab-layers-button" aria-selected={tab === "layers"} onclick={() => (tab = "layers")}>Layers</button>
    <span class="indicator" class:right={tab === "layers"} aria-hidden="true"></span>
  </div>
  <div class="body" inert={session.lock !== null}>
    <div class="pane" hidden={tab !== "design"} role="tabpanel" aria-labelledby="tab-design-button"><DesignTab /></div>
    <div class="pane" hidden={tab !== "layers"} role="tabpanel" aria-labelledby="tab-layers-button"><LayersTab /></div>
  </div>
</aside>

<style>
  .inspector { grid-area: inspector; background: var(--panel); border-left: 1px solid var(--line); display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .tabs { position: relative; display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid var(--line); flex: none; }
  .tabs button { border: 0; background: none; padding: 10px 0 9px; color: var(--muted); font-weight: 500; transition: color var(--fast); }
  .tabs button[aria-selected="true"] { color: var(--fg); }
  .indicator { position: absolute; bottom: -1px; left: 0; width: 50%; height: 2px; background: var(--ink); transition: transform var(--med) var(--ease); }
  .indicator.right { transform: translateX(100%); }
  .body { flex: 1; min-height: 0; position: relative; }
  .pane { position: absolute; inset: 0; overflow: auto; }
  :global(.app.locked) .body { opacity: 0.6; }
</style>
