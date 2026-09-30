<script lang="ts">
  import type { Snippet } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fade, reducedMotion } from "../lib/motion.js";

  let { open, label, onclose, align = "center", children }: { open: boolean; label: string; onclose: () => void; align?: "center" | "top"; children: Snippet } = $props();

  let panel: HTMLElement | undefined = $state();
  let returnTo: HTMLElement | null = null;

  /** A small rise-and-grow: the panel comes from where the eye already is. */
  function pop(_node: Element, { duration = 170 } = {}) {
    return {
      duration: reducedMotion() ? 0 : duration,
      easing: cubicOut,
      css: (t: number) => `opacity: ${t}; transform: translateY(${(1 - t) * 8}px) scale(${0.97 + t * 0.03});`,
    };
  }

  $effect(() => {
    if (!open || !panel) return;
    returnTo = document.activeElement as HTMLElement | null;
    const first = panel.querySelector<HTMLElement>("[autofocus], input, select, textarea, button");
    first?.focus();
    return () => returnTo?.focus?.();
  });

  function keydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      onclose();
    }
    // Keep Tab inside the dialog.
    if (e.key === "Tab" && panel) {
      const f = [...panel.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (f.length === 0) return;
      if (e.shiftKey && document.activeElement === f[0]) { f.at(-1)!.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { f[0]!.focus(); e.preventDefault(); }
    }
  }
</script>

{#if open}
  <div class="scrim {align}" role="presentation" transition:fade={{ duration: 140 }} onpointerdown={(e) => { if (e.target === e.currentTarget) onclose(); }}>
    <div class="panel" role="dialog" aria-modal="true" aria-label={label} tabindex="-1" bind:this={panel} transition:pop onkeydown={keydown}>
      {@render children()}
    </div>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 100; background: var(--scrim); display: grid; justify-items: center; padding: 24px; }
  .scrim.center { align-items: center; }
  .scrim.top { align-items: start; padding-top: 12vh; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); max-width: 100%; max-height: 100%; overflow: hidden; display: flex; flex-direction: column; outline: none; }
</style>
