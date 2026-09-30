<script lang="ts">
  /**
   * A number field whose label you can drag sideways to change the value
   * (Shift = ×10, Alt = ×0.1). One change is committed when the drag ends or
   * the typed value is confirmed, so one gesture is one undo step.
   */
  let {
    label,
    value,
    step = 1,
    min = -Infinity,
    max = Infinity,
    disabled = false,
    title = "",
    oncommit,
  }: { label: string; value: number | null; step?: number; min?: number; max?: number; disabled?: boolean; title?: string; oncommit: (v: number) => void } = $props();

  let draft: number | null = $state(null);
  const shown = $derived(draft ?? value);
  const fmt = (n: number | null) => (n === null || !Number.isFinite(n) ? "" : String(Math.round(n * 100) / 100));
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  function scrub(e: PointerEvent): void {
    if (disabled || value === null) return;
    const start = e.clientX;
    const base = value;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      const k = m.shiftKey ? 10 : m.altKey ? 0.1 : 1;
      draft = clamp(base + Math.round((m.clientX - start) / 2) * step * k);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      if (draft !== null && draft !== base) oncommit(draft);
      draft = null;
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up, { once: true });
    el.addEventListener("pointercancel", up, { once: true });
  }

  function typed(e: Event): void {
    const n = Number((e.target as HTMLInputElement).value);
    if (Number.isFinite(n) && n !== value) oncommit(clamp(n));
    else (e.target as HTMLInputElement).value = fmt(value);
  }
</script>

<label class="field" class:disabled {title}>
  <span class="lab" role="slider" aria-label="{label}, drag to change" aria-valuenow={shown ?? 0} tabindex="-1" onpointerdown={scrub}>{label}</span>
  <input type="text" inputmode="decimal" value={fmt(shown)} {disabled} onchange={typed} onkeydown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} aria-label={label} />
</label>

<style>
  .field { display: flex; align-items: center; gap: 6px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 7px; padding: 0 8px; height: 30px; min-width: 0; transition: border-color var(--fast); }
  .field:focus-within { border-color: var(--ink); }
  .lab { font-size: 11px; color: var(--muted); cursor: ew-resize; user-select: none; min-width: 12px; }
  .lab:hover { color: var(--ink); }
  input { border: 0; background: none; width: 100%; min-width: 0; outline: none; font-variant-numeric: tabular-nums; }
  .disabled { opacity: 0.6; }
  .disabled .lab { cursor: default; }
</style>
