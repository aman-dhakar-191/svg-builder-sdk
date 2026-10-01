<script lang="ts">
  import CodeXml from "@lucide/svelte/icons/code-xml";
  import AlignCenterVertical from "@lucide/svelte/icons/align-center-vertical";
  import Grid3x3 from "@lucide/svelte/icons/grid-3x3";
  import Magnet from "@lucide/svelte/icons/magnet";
  import Maximize from "@lucide/svelte/icons/maximize";
  import Minus from "@lucide/svelte/icons/minus";
  import Pause from "@lucide/svelte/icons/pause";
  import Play from "@lucide/svelte/icons/play";
  import Plus from "@lucide/svelte/icons/plus";
  import { onMount } from "svelte";
  import { fly } from "../lib/motion.js";
  import { formatKeys } from "../lib/commands.js";
  import { session } from "../lib/session.svelte.js";
  import Tip from "./Tip.svelte";

  let host: HTMLElement;
  let overlay: SVGSVGElement;
  let grid: SVGSVGElement;

  onMount(() => session.attachStage(host, overlay, grid));
  const locked = $derived(session.lock !== null);
  const fmt = (t: number) => `${t.toFixed(t < 10 ? 2 : 1)} s`;
</script>

<section class="stage" class:locked aria-label="Canvas">
  <div class="surface" inert={locked}>
    <!-- The canvas takes keyboard input (tool keys, arrows to nudge, Delete, Esc), so it must be focusable. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div id="canvas" role="application" aria-label="Drawing canvas" aria-roledescription="canvas" tabindex="0" data-tool={session.tool} bind:this={host}></div>
    <svg id="grid" aria-hidden="true" bind:this={grid}></svg>
    <svg id="overlay" aria-hidden="true" bind:this={overlay}></svg>
  </div>

  {#if session.lock}
    <div id="lock-banner" role="status" transition:fly={{ y: -12, duration: 180 }}>
      <span class="pulse" aria-hidden="true"></span>
      <span id="lock-label">{session.lock.label}</span>
      <button class="btn small" id="lock-keep" title="Stop and keep the changes made so far" onclick={() => session.stopLock(true)}>Stop &amp; keep</button>
      <button class="btn small warm" id="lock-stop" title="Stop and discard the changes made so far" onclick={() => session.stopLock(false)}>Stop</button>
    </div>
  {/if}

  <div class="float view" role="toolbar" aria-label="View" inert={locked}>
    <Tip text="Grid" keys={formatKeys("Mod+'")} side="top">
      <button class="icon-btn" data-view="grid" aria-label="Grid" aria-pressed={session.grid} onclick={() => session.viewport?.toggleGrid()}><Grid3x3 size={16} /></button>
    </Tip>
    <Tip text="Snap to grid" keys={formatKeys("Mod+Shift+'")} side="top">
      <button class="icon-btn" data-view="snap" aria-label="Snap to grid" aria-pressed={session.snap} onclick={() => session.viewport?.toggleSnap()}><Magnet size={16} /></button>
    </Tip>
    <Tip text="Snap to shapes (Alt while dragging: off)" side="top">
      <button class="icon-btn" data-view="snapShapes" aria-label="Snap to shapes" aria-pressed={session.snapShapes} onclick={() => session.toggleSnapShapes()}><AlignCenterVertical size={16} /></button>
    </Tip>
  </div>

  {#if session.motionEnd > 0}
    <div class="float playbar" role="toolbar" aria-label="Animation" transition:fly={{ y: 8, duration: 160 }}>
      <button class="icon-btn" id="play" aria-label={session.playing ? "Pause" : "Play"} title="{session.playing ? 'Pause' : 'Play'} the animation" onclick={() => session.togglePlay()}>
        {#if session.playing}<Pause size={16} />{:else}<Play size={16} />{/if}
      </button>
      <input id="timeline" type="range" min="0" max={session.motionEnd} step="0.01" aria-label="Animation time"
        value={session.playTime ?? session.motionEnd}
        oninput={(e) => session.seekMotion(Number((e.target as HTMLInputElement).value))} />
      <span id="play-time" class="time">{fmt(session.playTime ?? session.motionEnd)} / {fmt(session.motionEnd)}</span>
      {#if session.playTime !== null && !session.playing}
        <button class="btn small ghost" id="play-done" title="Back to editing (the drawing at the end of its motion)" onclick={() => session.restMotion()}>Done</button>
      {/if}
    </div>
  {/if}

  <div class="float zoom" role="toolbar" aria-label="Zoom">
    <button class="icon-btn" data-view="zoomOut" aria-label="Zoom out" onclick={() => session.viewport?.zoomOut()}><Minus size={16} /></button>
    <button class="zoomval" id="zoom" title="Actual size ({formatKeys('Mod+1')})" onclick={() => session.viewport?.setZoom(1)}>{Math.round(session.zoom * 100)}%</button>
    <button class="icon-btn" data-view="zoomIn" aria-label="Zoom in" onclick={() => session.viewport?.zoomIn()}><Plus size={16} /></button>
    <Tip text="Zoom to fit" keys={formatKeys("Mod+0")} side="top">
      <button class="icon-btn" data-view="fit" aria-label="Zoom to fit" onclick={() => session.viewport?.fit()}><Maximize size={15} /></button>
    </Tip>
  </div>

  {#if session.mode === "agent"}
    <div class="float peek" transition:fly={{ y: -8, duration: 160 }}>
      <button class="btn" onclick={() => session.setMode("editor")}><CodeXml size={15} />Open in editor</button>
    </div>
  {/if}
</section>

<style>
  .stage { grid-area: canvas; position: relative; min-width: 0; min-height: 0; overflow: hidden; background: var(--desk); view-transition-name: stage; }
  .surface { position: absolute; inset: 0; }
  .float { position: absolute; display: flex; align-items: center; gap: 2px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 3px; box-shadow: var(--shadow); z-index: 3; }
  .view { left: 12px; bottom: 12px; }
  .zoom { right: 12px; bottom: 12px; }
  .playbar { left: 50%; bottom: 56px; transform: translateX(-50%); gap: 8px; padding: 3px 10px 3px 3px; }
  .playbar input { width: clamp(80px, 22vw, 260px); accent-color: var(--ink); }
  .time { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--muted); white-space: nowrap; }
  .zoomval { min-width: 52px; height: 30px; border: 0; background: none; border-radius: 7px; font-variant-numeric: tabular-nums; font-size: 12px; }
  .zoomval:hover { background: var(--hover); }
  .peek { right: 12px; top: 12px; padding: 0; border: 0; background: none; box-shadow: none; }
  .peek .btn { box-shadow: var(--shadow); }
  :global(.app[data-mode="agent"]) .view { display: none; }

  #lock-banner {
    position: absolute; left: 50%; top: 12px; transform: translateX(-50%); z-index: 4;
    display: flex; align-items: center; gap: 10px; max-width: calc(100% - 24px);
    background: var(--warm-soft); border: 1px solid var(--warm); border-radius: 999px; padding: 4px 4px 4px 14px; box-shadow: var(--shadow); white-space: nowrap;
  }
  #lock-label { overflow: hidden; text-overflow: ellipsis; }
  .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--warm); animation: pulse 1.2s ease-in-out infinite; flex: none; }
  @keyframes pulse { 50% { opacity: 0.3; transform: scale(0.8); } }
  .locked :global(#canvas > svg) { box-shadow: 0 0 0 2px var(--warm), 0 4px 18px rgb(0 0 0 / 0.14); }
</style>
