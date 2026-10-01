<script lang="ts" module>
  // The options stay as they were set while the selection changes.
  // Number inputs bind numbers (null when empty).
  const opts: { duration: number | null; delay: number | null; trigger: string; repeat: string; from: string; stagger: number | null } = $state({ duration: null, delay: null, trigger: "load", repeat: "auto", from: "bottom", stagger: 0.1 });
</script>

<script lang="ts">
  import Pause from "@lucide/svelte/icons/pause";
  import Play from "@lucide/svelte/icons/play";
  import X from "@lucide/svelte/icons/x";
  import { ANIMATION_TAGS, MOTION_PRESETS, PRESET_INFO, type AnimateOptions, type MotionPreset, type MotionTrigger, type NodeId } from "@svg-editor/sdk";
  import { session } from "../lib/session.svelte.js";

  let { ids }: { ids: NodeId[] } = $props();

  /** Presets on the selected elements (in order of first use), and how many hand-written animations. */
  const applied = $derived.by(() => {
    void session.docVersion;
    const doc = session.editor.doc;
    const presets: string[] = [];
    let custom = 0;
    for (const id of ids) {
      if (!doc.has(id)) continue;
      for (const c of doc.getNode(id).children) {
        const n = doc.getNode(c);
        if (!ANIMATION_TAGS.has(n.tag)) continue;
        const p = n.attrs["data-motion"];
        if (!p) custom++;
        else if (!presets.includes(p)) presets.push(p);
      }
    }
    return { presets, custom };
  });

  const label = (p: string) => (p in PRESET_INFO ? PRESET_INFO[p as MotionPreset].label : p);
  const seconds = (v: number | null): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

  function apply(preset: MotionPreset): void {
    const o: AnimateOptions = { trigger: opts.trigger as MotionTrigger };
    const duration = seconds(opts.duration);
    const delay = seconds(opts.delay);
    if (duration) o.duration = duration;
    if (delay !== undefined) o.delay = delay;
    if (opts.repeat === "once") o.repeat = 1;
    if (opts.repeat === "forever") o.repeat = "indefinite";
    if (preset === "slideIn") o.from = opts.from as "left" | "right" | "top" | "bottom";
    if (ids.length > 1) o.stagger = seconds(opts.stagger) ?? 0;
    session.animate(preset, o);
  }
</script>

<section class="sec motion" aria-label="Motion">
  <h3 class="eyebrow">Motion
    {#if session.motionEnd > 0}
      <button class="icon-btn" aria-label={session.playing ? "Pause" : "Play"} title="Preview the drawing's motion" onclick={() => session.togglePlay()}>{#if session.playing}<Pause size={14} />{:else}<Play size={14} />{/if}</button>
    {/if}
  </h3>

  {#each [["Entrance", "entrance"], ["Loop", "loop"]] as const as [title, kind]}
    <span class="hint">{title}</span>
    <div class="presets">
      {#each MOTION_PRESETS.filter((p) => PRESET_INFO[p].kind === kind) as p (p)}
        <button class="btn small" data-preset={p} onclick={() => apply(p)} title="{PRESET_INFO[p].label}: {PRESET_INFO[p].duration} s by default">{PRESET_INFO[p].label}</button>
      {/each}
    </div>
  {/each}

  <div class="opts">
    <label><span class="hint">Duration (s)</span><input class="input" id="motion-duration" type="number" min="0.05" step="0.1" placeholder="auto" bind:value={opts.duration} /></label>
    <label><span class="hint">Delay (s)</span><input class="input" id="motion-delay" type="number" min="0" step="0.1" placeholder="0" bind:value={opts.delay} /></label>
    <label><span class="hint">Starts</span>
      <select class="input" id="motion-trigger" bind:value={opts.trigger}>
        <option value="load">On open</option>
        <option value="click">On click</option>
        <option value="hover">On hover</option>
      </select>
    </label>
    <label><span class="hint">Repeat</span>
      <select class="input" id="motion-repeat" bind:value={opts.repeat}>
        <option value="auto">Auto</option>
        <option value="once">Once</option>
        <option value="forever">Forever</option>
      </select>
    </label>
    <label><span class="hint">Slide from</span>
      <select class="input" id="motion-from" bind:value={opts.from}>
        <option value="bottom">Bottom</option>
        <option value="top">Top</option>
        <option value="left">Left</option>
        <option value="right">Right</option>
      </select>
    </label>
    {#if ids.length > 1}
      <label><span class="hint">Stagger (s)</span><input class="input" id="motion-stagger" type="number" min="0" step="0.05" bind:value={opts.stagger} /></label>
    {/if}
  </div>

  {#if applied.presets.length || applied.custom}
    <div class="chips" aria-label="Applied motion">
      {#each applied.presets as p (p)}
        <span class="chip" data-applied={p}>{label(p)}<button aria-label="Remove {label(p)}" title="Remove {label(p)}" onclick={() => session.removeMotion(p)}><X size={12} /></button></span>
      {/each}
      {#if applied.custom}<span class="chip plain">{applied.custom} written in code</span>{/if}
    </div>
    <button class="btn small ghost remove-all" id="motion-remove-all" onclick={() => session.removeMotion()}>Remove all motion</button>
  {:else}
    <p class="hint">Click a preset to animate {ids.length > 1 ? `these ${ids.length} shapes, one after another` : "this shape"}. Saved as SMIL in the SVG: it plays in browsers.</p>
  {/if}
</section>

<style>
  .sec { padding: 12px 14px; border-bottom: 1px solid var(--line); display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
  h3 { margin: 0; display: flex; align-items: center; justify-content: space-between; }
  h3 .icon-btn { width: 24px; height: 24px; color: var(--ink); }
  .presets { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  .presets .btn { justify-content: center; }
  .opts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .opts label { display: grid; gap: 2px; min-width: 0; }
  .opts .input { width: 100%; min-width: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { display: inline-flex; align-items: center; gap: 2px; padding: 2px 4px 2px 8px; border-radius: 999px; background: var(--ink-soft); color: var(--ink); font-size: 12px; font-weight: 500; }
  .chip.plain { padding-right: 8px; background: var(--panel-2); color: var(--muted); }
  .chip button { border: 0; background: none; color: inherit; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; padding: 0; }
  .chip button:hover { background: color-mix(in srgb, var(--ink) 15%, transparent); }
  .remove-all { justify-self: start; }
</style>
