<script lang="ts">
  /** A paint value (fill / stroke): swatch with the system colour picker, the raw value, and "none". */
  let { label, value, palette = [], oncommit }: { label: string; value: string | undefined; palette?: string[]; oncommit: (v: string | null) => void } = $props();

  const ctx = document.createElement("canvas").getContext("2d")!;
  /** Any CSS colour -> #rrggbb for the picker; null for none, gradients (url(...)) and the like. */
  function hex(v: string | undefined): string | null {
    if (!v || v === "none" || v.startsWith("url(")) return null;
    ctx.fillStyle = "#000000";
    ctx.fillStyle = v;
    return /^#[0-9a-f]{6}$/i.test(ctx.fillStyle) ? ctx.fillStyle : null;
  }
  const h = $derived(hex(value));
  let picking: string | null = $state(null);
</script>

<div class="row">
  <label class="swatch" class:none={!h && !picking} style:background={picking ?? h ?? undefined} title="Pick a colour">
    <input type="color" value={h ?? "#000000"} aria-label="{label} colour"
      oninput={(e) => (picking = (e.target as HTMLInputElement).value)}
      onchange={(e) => { picking = null; oncommit((e.target as HTMLInputElement).value); }} />
  </label>
  <input class="input value" value={value ?? ""} placeholder="default" aria-label="{label} value" spellcheck="false"
    onchange={(e) => { const v = (e.target as HTMLInputElement).value.trim(); oncommit(v === "" ? null : v); }} />
  <button class="btn small ghost" onclick={() => oncommit("none")} disabled={value === "none"}>None</button>
</div>
{#if palette.length}
  <div class="palette" aria-label="Colours in this drawing">
    {#each palette as c}
      <button style:background={c} title={c} aria-label="{label} {c}" class:on={c === value} onclick={() => oncommit(c)}></button>
    {/each}
  </div>
{/if}

<style>
  .row { display: flex; align-items: center; gap: 6px; }
  .swatch { position: relative; width: 30px; height: 30px; border-radius: 7px; border: 1px solid var(--line); flex: none; cursor: pointer; overflow: hidden; transition: transform var(--fast); }
  .swatch:hover { transform: scale(1.06); }
  .swatch input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .swatch.none { background: linear-gradient(135deg, transparent 45%, var(--err) 45% 55%, transparent 55%), var(--panel); }
  .value { flex: 1; font-family: var(--f-mono); font-size: 12px; }
  .palette { display: flex; flex-wrap: wrap; gap: 5px; }
  .palette button { width: 20px; height: 20px; border-radius: 5px; border: 1px solid var(--line); padding: 0; transition: transform var(--fast), box-shadow var(--fast); }
  .palette button:hover { transform: scale(1.12); }
  .palette button.on { box-shadow: 0 0 0 2px var(--panel), 0 0 0 3.5px var(--ink); }
</style>
