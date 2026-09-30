<script lang="ts">
  import type { Snippet } from "svelte";
  import { fade } from "../lib/motion.js";

  let { text, keys, side = "bottom", children }: { text: string; keys?: string; side?: "right" | "bottom" | "top"; children: Snippet } = $props();
  let show = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  // A short delay: tips appear when you pause on a control, not while you sweep past.
  function enter(): void {
    clearTimeout(timer);
    timer = setTimeout(() => (show = true), 450);
  }
  function leave(): void {
    clearTimeout(timer);
    show = false;
  }
</script>

<span class="wrap" role="presentation" onpointerenter={enter} onpointerleave={leave} onfocusin={enter} onfocusout={leave} onpointerdown={leave}>
  {@render children()}
  {#if show}
    <span class="tip {side}" role="tooltip" transition:fade={{ duration: 100 }}>{text}{#if keys}<span class="keys">{keys}</span>{/if}</span>
  {/if}
</span>

<style>
  .wrap { position: relative; display: inline-flex; }
  .tip { position: absolute; z-index: 60; pointer-events: none; white-space: nowrap; display: inline-flex; align-items: center; gap: 8px; background: var(--fg); color: var(--panel); font-size: 12px; padding: 4px 8px; border-radius: 6px; box-shadow: var(--shadow); }
  .right { left: calc(100% + 8px); top: 50%; transform: translateY(-50%); }
  .bottom { top: calc(100% + 6px); left: 50%; transform: translateX(-50%); }
  .top { bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); }
  .keys { font: 11px var(--f-mono); opacity: 0.7; }
</style>
