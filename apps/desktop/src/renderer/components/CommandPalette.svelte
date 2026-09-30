<script lang="ts">
  import CornerDownLeft from "@lucide/svelte/icons/corner-down-left";
  import Search from "@lucide/svelte/icons/search";
  import { tick } from "svelte";
  import { COMMANDS, formatKeys } from "../lib/commands.js";
  import { session, type Theme } from "../lib/session.svelte.js";
  import Dialog from "./Dialog.svelte";

  interface Entry {
    label: string;
    group: string;
    keys?: string;
    words: string;
    run: () => void;
  }

  const open = $derived(session.overlay === "palette");
  let query = $state("");
  let active = $state(0);
  let list: HTMLElement | undefined = $state();

  const entries = $derived.by((): Entry[] => {
    const base: Entry[] = COMMANDS.filter((c) => c.action !== "commandPalette").map((c) => ({
      label: c.label, group: c.menu, ...(c.keys ? { keys: c.keys } : {}), words: `${c.label} ${c.menu} ${c.keywords ?? ""}`.toLowerCase(), run: () => session.run(c.action),
    }));
    const themes: Entry[] = (["system", "light", "dark"] as Theme[]).map((t) => ({
      label: `Theme: ${t === "system" ? "match the system" : t}`, group: "Appearance", words: `theme: ${t === "system" ? "match the system automatic" : t} appearance colour color mode`, run: () => session.setTheme(t),
    }));
    const tools: Entry[] = (["select", "rect", "ellipse", "line", "text"] as const).map((t) => ({
      label: `Tool: ${t === "rect" ? "rectangle" : t}`, group: "Tools", words: `tool ${t} ${t === "rect" ? "rectangle square" : ""} draw`, run: () => { session.setMode("editor"); session.canvas?.setTool(t); },
    }));
    const extra: Entry[] = [
      { label: "Align left", group: "Arrange", words: "align left arrange", run: () => session.align("left") },
      { label: "Align centres horizontally", group: "Arrange", words: "align center centre horizontal arrange", run: () => session.align("center") },
      { label: "Align right", group: "Arrange", words: "align right arrange", run: () => session.align("right") },
      { label: "Align top", group: "Arrange", words: "align top arrange", run: () => session.align("top") },
      { label: "Align centres vertically", group: "Arrange", words: "align middle vertical arrange", run: () => session.align("middle") },
      { label: "Align bottom", group: "Arrange", words: "align bottom arrange", run: () => session.align("bottom") },
    ];
    return [...base, ...tools, ...extra, ...themes];
  });

  /** Every typed word must appear; entries whose label starts with the query rank first. */
  const results = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    const words = q.split(/\s+/);
    // "theme dark" should rank "Theme: dark" first, so punctuation is ignored when comparing prefixes.
    const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const head = plain(q);
    const rank = (e: Entry) => Number(!plain(e.label).startsWith(head));
    return entries.filter((e) => words.every((w) => e.words.includes(w))).sort((a, b) => rank(a) - rank(b));
  });

  $effect(() => {
    if (open) {
      query = "";
      active = 0;
    }
  });
  $effect(() => {
    void query;
    active = 0;
  });

  function run(e: Entry): void {
    session.overlay = null;
    // Let the dialog close (and focus return) before the action runs.
    tick().then(e.run);
  }
  async function move(d: number): Promise<void> {
    if (!results.length) return;
    active = (active + d + results.length) % results.length;
    await tick();
    list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }
  function keydown(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter" && results[active]) run(results[active]!);
    else return;
    e.preventDefault();
  }
</script>

<Dialog {open} label="Command palette" align="top" onclose={() => (session.overlay = null)}>
  <div class="palette">
    <div class="search">
      <Search size={16} />
      <input placeholder="Type an action: union, export, theme, zoom…" bind:value={query} onkeydown={keydown} aria-label="Search actions" aria-controls="palette-list" />
      <span class="kbd">Esc</span>
    </div>
    <ul id="palette-list" role="listbox" bind:this={list}>
      {#each results as r, i (r.label)}
        <li role="option" aria-selected={i === active} onpointermove={() => (active = i)} onclick={() => run(r)} onkeydown={() => {}}>
          <span class="label">{r.label}</span>
          <span class="group">{r.group}</span>
          {#if r.keys}<span class="kbd">{formatKeys(r.keys)}</span>{/if}
          {#if i === active}<span class="enter" aria-hidden="true"><CornerDownLeft size={13} /></span>{/if}
        </li>
      {:else}
        <li class="empty">No action matches “{query}”.</li>
      {/each}
    </ul>
  </div>
</Dialog>

<style>
  .palette { width: min(580px, 92vw); display: flex; flex-direction: column; max-height: 60vh; }
  .search { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--line); color: var(--muted); }
  .search input { flex: 1; border: 0; background: none; outline: none; font-size: 15px; color: var(--fg); }
  ul { list-style: none; margin: 0; padding: 6px; overflow: auto; }
  li { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
  li[aria-selected="true"] { background: var(--ink-soft); }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group { font-size: 11px; color: var(--muted); }
  .enter { color: var(--ink); display: inline-grid; }
  .empty { color: var(--muted); cursor: default; }
</style>
