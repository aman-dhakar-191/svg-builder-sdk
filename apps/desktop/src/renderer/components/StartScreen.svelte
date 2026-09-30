<script lang="ts">
  import FilePlus2 from "@lucide/svelte/icons/file-plus-2";
  import FileText from "@lucide/svelte/icons/file-text";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import { fly } from "../lib/motion.js";
  import type { RecentFile } from "../../shared/api.js";
  import { agent } from "../lib/agent.svelte.js";
  import { session } from "../lib/session.svelte.js";
  import Dialog from "./Dialog.svelte";

  const open = $derived(session.overlay === "start");
  let recent: RecentFile[] = $state([]);

  $effect(() => {
    if (open) void window.desktop?.recentFiles().then((r) => (recent = r));
  });

  function when(t: number): string {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "Just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    return d === 1 ? "Yesterday" : `${d} days ago`;
  }
  function askAgent(): void {
    session.overlay = null;
    session.newDocument();
    agent.draft = "A flat icon of a paper plane";
    session.setMode("agent");
  }
</script>

<Dialog {open} label="Start" onclose={() => (session.overlay = null)}>
  <div class="start">
    <div>
      <h2>Start a drawing</h2>
      <p class="lead">Open a file, start from a blank page, or describe what you want and let the agent draw a first version.</p>
    </div>
    <div class="actions">
      <button onclick={() => session.newDocument()} in:fly={{ y: 6, duration: 160 }}><FilePlus2 size={18} /><strong>New drawing</strong><span>Blank 400 × 300 page</span></button>
      <button onclick={() => session.run("open")} in:fly={{ y: 6, duration: 160, delay: 30 }}><FolderOpen size={18} /><strong>Open…</strong><span>An SVG file from your computer</span></button>
      <button class="ai" onclick={askAgent} in:fly={{ y: 6, duration: 160, delay: 60 }}><Sparkles size={18} /><strong>Ask the agent</strong><span>“A flat icon of a paper plane”</span></button>
    </div>
    <div class="recent">
      <h3 class="eyebrow">Recent</h3>
      {#if recent.length}
        <ul>
          {#each recent as r (r.id)}
            <li><button onclick={() => session.openRecent(r.id)}><FileText size={16} /><span class="name">{r.name}</span><span class="folder">{r.folder}</span><span class="when">{when(r.openedAt)}</span></button></li>
          {/each}
        </ul>
      {:else}
        <p class="hint">Files you open or save appear here.</p>
      {/if}
    </div>
  </div>
</Dialog>

<style>
  .start { width: min(720px, 92vw); padding: 26px; display: grid; gap: 22px; overflow: auto; }
  h2 { margin: 0; font-size: 20px; font-weight: 600; text-wrap: balance; }
  .lead { margin: 6px 0 0; color: var(--muted); }
  .actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .actions button { display: grid; gap: 6px; justify-items: start; text-align: left; border: 1px solid var(--line); background: var(--panel-2); border-radius: 12px; padding: 14px; transition: border-color var(--fast), transform var(--fast), box-shadow var(--fast); }
  .actions button:hover { border-color: var(--line-strong); transform: translateY(-2px); box-shadow: var(--shadow); }
  .actions strong { font-weight: 600; }
  .actions span { font-size: 12px; color: var(--muted); }
  .actions .ai { border-color: color-mix(in srgb, var(--warm) 45%, var(--line)); background: var(--warm-soft); }
  .actions .ai :global(svg) { color: var(--warm); }
  .recent { display: grid; gap: 8px; }
  .recent h3 { margin: 0; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  li button { width: 100%; display: grid; grid-template-columns: auto 1fr auto auto; gap: 10px; align-items: center; text-align: left; border: 0; background: none; padding: 8px 10px; border-radius: 8px; color: var(--muted); }
  li button:hover { background: var(--hover); color: var(--fg); }
  .name { color: var(--fg); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .folder, .when { font-size: 12px; }
  @media (max-width: 700px) { .actions { grid-template-columns: 1fr; } }
</style>
