<script lang="ts">
  import Circle from "@lucide/svelte/icons/circle";
  import Pause from "@lucide/svelte/icons/pause";
  import Play from "@lucide/svelte/icons/play";
  import X from "@lucide/svelte/icons/x";
  import { PRESET_INFO, TEXT_TAG, type KeyProperty, type MotionPreset, type NodeId } from "@svg-editor/sdk";
  import { session } from "../lib/session.svelte.js";

  const LABELS: Record<KeyProperty, string> = { translate: "Position", rotate: "Rotation", scale: "Scale", opacity: "Opacity", fill: "Fill", stroke: "Stroke" };

  interface Row {
    id: NodeId;
    label: string;
    /** Preset animations as bars (seconds). */
    bars: { label: string; from: number; to: number }[];
    tracks: { property: KeyProperty; times: number[] }[];
  }

  /** Animated elements, plus the selected one (so it can get its first keys). */
  const rows: Row[] = $derived.by(() => {
    void session.docVersion;
    const doc = session.editor.doc;
    const out: Row[] = [];
    const seen = new Set<NodeId>();
    const anims = doc.getAnimations();
    const targets = [...new Set(anims.map((a) => a.target)), ...session.selection.filter((id) => doc.has(id))];
    for (const id of targets) {
      if (seen.has(id) || id === doc.root) continue;
      seen.add(id);
      const n = doc.getNode(id);
      const text = n.children.map((c) => doc.getNode(c)).filter((c) => c.tag === TEXT_TAG).map((c) => c.text ?? "").join("").trim();
      const label = n.attrs.id ? `#${n.attrs.id}` : text ? `“${text.slice(0, 14)}”` : `<${n.tag}>`;
      const bars: Row["bars"] = [];
      const presets = new Set<string>();
      for (const a of anims) {
        if (a.target !== id || !a.preset || a.preset === "keys" || presets.has(a.preset) || a.duration === null) continue;
        presets.add(a.preset);
        const runs = a.repeat === "indefinite" ? 1 : a.repeat;
        bars.push({ label: a.preset in PRESET_INFO ? PRESET_INFO[a.preset as MotionPreset].label : a.preset, from: a.delay, to: a.delay + a.duration * runs });
      }
      const tracks = doc.getKeyframes(id).map((t) => ({ property: t.property, times: t.keys.map((k) => k.time) }));
      out.push({ id, label, bars, tracks });
    }
    return out;
  });

  const length = $derived(Math.max(session.timelineLength, session.motionEnd, session.playhead));
  let width = $state(600);
  const x = (t: number) => (t / length) * width;
  const timeAt = (px: number) => Math.max(0, Math.min(length, (px / width) * length));
  const now = $derived(session.playing && session.playTime !== null ? session.playTime : session.playhead);
  const ticks = $derived.by(() => {
    const step = length <= 2 ? 0.25 : length <= 6 ? 0.5 : length <= 15 ? 1 : 2;
    const out: number[] = [];
    for (let t = 0; t <= length + 1e-9; t += step) out.push(Math.round(t * 100) / 100);
    return out;
  });
  const snap = (t: number) => Math.round(t / 0.05) * 0.05;

  /** Click or drag on the ruler or a track: move the playhead there. */
  function scrub(e: PointerEvent, area: HTMLElement): void {
    if (e.button !== 0) return;
    const left = area.getBoundingClientRect().left;
    const go = (ev: PointerEvent) => session.setPlayhead(snap(timeAt(ev.clientX - left)));
    if (session.playing) session.togglePlay();
    go(e);
    const up = () => {
      window.removeEventListener("pointermove", go);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", go);
    window.addEventListener("pointerup", up);
  }

  /** A key: click selects it (and its shape, and moves the playhead there); drag moves it in time. */
  function grabKey(e: PointerEvent, id: NodeId, property: KeyProperty, time: number, area: HTMLElement): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    const left = area.getBoundingClientRect().left;
    const startX = e.clientX;
    let to = time;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) < 3 && to === time) return;
      to = snap(timeAt(ev.clientX - left));
      target.style.left = `${x(to)}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      session.editor.select([id]);
      if (Math.abs(to - time) > 1e-6) {
        session.guard(() => {
          try {
            session.editor.doc.moveKeyframe(id, property, time, to);
          } catch (err) {
            session.showStatus(err instanceof Error ? err.message : String(err), true);
          }
        });
      }
      session.activeKey = { id, property, time: Math.round(to * 1000) / 1000 };
      session.setPlayhead(to);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const isActive = (id: NodeId, p: KeyProperty, t: number) => session.activeKey?.id === id && session.activeKey.property === p && Math.abs(session.activeKey.time - t) < 1e-6;
  const fmt = (t: number) => `${t.toFixed(2)} s`;
</script>

<section class="timeline" id="timeline-panel" aria-label="Timeline">
  <header>
    <button class="icon-btn" id="tl-play" aria-label={session.playing ? "Pause" : "Play"} onclick={() => session.togglePlay()}>
      {#if session.playing}<Pause size={15} />{:else}<Play size={15} />{/if}
    </button>
    <span class="time" id="tl-time">{fmt(now)}</span>
    <button class="btn small rec" id="tl-record" aria-pressed={session.recording} title="Record: moving, rotating, resizing or recolouring a shape adds keyframes at the playhead" onclick={() => (session.recording = !session.recording)}>
      <Circle size={11} />Record
    </button>
    <span class="hint grow">{session.recording ? "Recording: changes become keyframes at the playhead." : "Drag the playhead, turn Record on, then move or restyle a shape."}</span>
    <label class="len">Length <input class="input" id="tl-length" type="number" min="0.5" max="600" step="0.5" value={session.timelineLength} onchange={(e) => { const v = Number((e.target as HTMLInputElement).value); if (v > 0) session.timelineLength = v; }} /> s</label>
    <button class="icon-btn" aria-label="Close the timeline" onclick={() => session.toggleTimeline(false)}><X size={15} /></button>
  </header>

  <div class="grid">
    <div class="labels">
      <div class="ruler-gap"></div>
      {#each rows as r (r.id)}
        <button class="row-label" class:selected={session.selection.includes(r.id)} onclick={() => session.editor.select([r.id])}>{r.label}</button>
        {#each r.tracks as t (t.property)}<div class="track-label">{LABELS[t.property]}</div>{/each}
      {:else}
        <p class="hint empty">Select a shape to animate it.</p>
      {/each}
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="lanes" bind:clientWidth={width} onpointerdown={(e) => scrub(e, e.currentTarget as HTMLElement)}>
      <div class="ruler">
        {#each ticks as t}<span class="tick" style:left="{x(t)}px">{Number.isInteger(t) ? `${t}s` : ""}</span>{/each}
      </div>
      {#each rows as r (r.id)}
        <div class="lane element">
          {#each r.bars as b}<span class="bar" style:left="{x(b.from)}px" style:width="{Math.max(4, x(b.to) - x(b.from))}px" title={b.label}>{b.label}</span>{/each}
        </div>
        {#each r.tracks as t (t.property)}
          <div class="lane">
            {#each t.times as time (time)}
              <button
                class="key"
                class:active={isActive(r.id, t.property, time)}
                data-key="{r.id}:{t.property}:{time}"
                style:left="{x(time)}px"
                aria-label="{LABELS[t.property]} keyframe at {fmt(time)}"
                title="{LABELS[t.property]} at {fmt(time)}: drag to move, Delete to remove"
                onpointerdown={(e) => grabKey(e, r.id, t.property, time, (e.currentTarget as HTMLElement).closest(".lanes") as HTMLElement)}
                onkeydown={(e) => { if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); session.activeKey = { id: r.id, property: t.property, time }; session.deleteActiveKey(); } }}
              ></button>
            {/each}
          </div>
        {/each}
      {/each}
      <div class="playhead" style:left="{x(now)}px" aria-hidden="true"></div>
    </div>
  </div>
</section>

<style>
  .timeline { position: absolute; left: 0; right: 0; bottom: 0; height: var(--timeline-h); background: var(--panel); border-top: 1px solid var(--line); display: flex; flex-direction: column; z-index: 4; }
  header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--line); flex: none; }
  .time { font-variant-numeric: tabular-nums; font-size: 12px; min-width: 52px; }
  .rec { gap: 6px; }
  .rec :global(svg) { color: var(--muted); }
  .rec[aria-pressed="true"] { border-color: var(--err); color: var(--err); }
  .rec[aria-pressed="true"] :global(svg) { color: var(--err); fill: var(--err); }
  .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .len { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
  .len input { width: 58px; height: 26px; }
  .grid { flex: 1; min-height: 0; display: grid; grid-template-columns: 150px 1fr; overflow: auto; }
  .labels { border-right: 1px solid var(--line); padding: 0 0 8px; }
  .ruler-gap, .ruler { height: 22px; }
  .row-label, .track-label { height: 24px; display: flex; align-items: center; padding: 0 10px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row-label { width: 100%; border: 0; background: none; font-weight: 600; text-align: left; }
  .row-label.selected { color: var(--ink); }
  .track-label { color: var(--muted); padding-left: 22px; }
  .empty { padding: 8px 10px; }
  .lanes { position: relative; margin: 0 14px 8px 10px; cursor: text; }
  .ruler { position: relative; border-bottom: 1px solid var(--line); }
  .tick { position: absolute; top: 0; height: 100%; border-left: 1px solid var(--line); font-size: 10px; color: var(--muted); padding-left: 3px; }
  .lane { position: relative; height: 24px; border-bottom: 1px dashed color-mix(in srgb, var(--line) 60%, transparent); }
  .lane.element { border-bottom-style: solid; }
  .bar { position: absolute; top: 5px; height: 14px; border-radius: 4px; background: var(--ink-soft); color: var(--ink); font-size: 10px; line-height: 14px; padding: 0 4px; overflow: hidden; white-space: nowrap; }
  .key {
    position: absolute; top: 6px; width: 12px; height: 12px; margin-left: -6px; padding: 0; border: 1.5px solid var(--ink);
    background: var(--panel); transform: rotate(45deg); border-radius: 2px; cursor: grab;
  }
  .key:hover, .key:focus-visible { background: var(--ink-soft); }
  .key.active { background: var(--ink); }
  .playhead { position: absolute; top: 0; bottom: 0; width: 0; border-left: 2px solid var(--warm); pointer-events: none; }
  .playhead::before { content: ""; position: absolute; top: 0; left: -6px; border: 5px solid transparent; border-top: 7px solid var(--warm); }
</style>
