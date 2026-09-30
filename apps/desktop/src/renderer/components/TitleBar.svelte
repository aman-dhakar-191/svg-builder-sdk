<script lang="ts">
  import Download from "@lucide/svelte/icons/download";
  import PenTool from "@lucide/svelte/icons/pen-tool";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Search from "@lucide/svelte/icons/search";
  import Settings from "@lucide/svelte/icons/settings";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import { formatKeys, IS_MAC } from "../lib/commands.js";
  import { session } from "../lib/session.svelte.js";
  import { fly } from "../lib/motion.js";
  import MenuBar from "./MenuBar.svelte";
</script>

<header class="titlebar" class:mac={IS_MAC}>
  <div class="left">
    <span class="mark" aria-hidden="true"><svg viewBox="0 0 128 128"><rect width="128" height="128" rx="29" fill="#0d0f1a"/><g transform="translate(64 64) scale(1.02) translate(-63 -65)"><defs><linearGradient id="tbgS" gradientUnits="userSpaceOnUse" x1="104" y1="22" x2="62" y2="112"><stop offset="0" stop-color="#62e6ff"/><stop offset="0.3" stop-color="#4f7cff"/><stop offset="0.55" stop-color="#8b5cf6"/><stop offset="0.8" stop-color="#ec4899"/><stop offset="1" stop-color="#fb923c"/></linearGradient><linearGradient id="tbfS" gradientUnits="userSpaceOnUse" x1="16" y1="70" x2="112" y2="96"><stop offset="0" stop-color="#ec4899"/><stop offset="1" stop-color="#fdba74"/></linearGradient><clipPath id="tbcS"><path d="M104 40 C92 22 70 16 54 20 C30 26 18 46 18 66 C18 92 40 110 66 110 C82 110 96 102 108 88 C96 96 84 98 72 96 C52 92 42 78 42 64 C42 50 52 38 68 36 C84 34 96 36 104 40 Z"/></clipPath></defs><path d="M104 40 C92 22 70 16 54 20 C30 26 18 46 18 66 C18 92 40 110 66 110 C82 110 96 102 108 88 C96 96 84 98 72 96 C52 92 42 78 42 64 C42 50 52 38 68 36 C84 34 96 36 104 40 Z" fill="url(#tbgS)" stroke="url(#tbgS)" stroke-width="5" stroke-linejoin="round"/><g clip-path="url(#tbcS)"><path d="M16 70 C28 94 50 106 72 101 C88 98 100 92 112 86 C96 90 82 88 70 84 C52 78 36 72 16 70 Z" fill="url(#tbfS)" opacity="0.9"/></g></g></svg></span>
    {#if !IS_MAC}<MenuBar />{/if}
    <span class="docname" title={session.docName}>
      {session.docName}{#if session.dirty}<span class="dirty" aria-label="unsaved changes"> · edited</span>{/if}
    </span>
  </div>

  <div class="modeswitch" role="radiogroup" aria-label="Workspace">
    <span class="thumb" class:agent={session.mode === "agent"} aria-hidden="true"></span>
    <button role="radio" data-mode-switch="editor" aria-checked={session.mode === "editor"} onclick={() => session.setMode("editor")} title="Draw and edit ({formatKeys('Mod+E')})">
      <PenTool size={15} class="ico-editor" />Editor
    </button>
    <button role="radio" data-mode-switch="agent" aria-checked={session.mode === "agent"} onclick={() => session.setMode("agent")} title="Work with the agent ({formatKeys('Mod+E')})">
      <Sparkles size={15} class="ico-agent" />Agent
    </button>
  </div>

  <div class="right">
    <button class="search" id="open-palette" onclick={() => (session.overlay = "palette")}>
      <Search size={15} /><span class="label">Search actions</span><span class="kbd">{formatKeys("Mod+K")}</span>
    </button>
    <button class="icon-btn" id="open-settings" aria-label="Settings" title="Settings ({formatKeys('Mod+,')})" onclick={() => (session.overlay = "settings")}>
      <Settings size={17} />
    </button>
    {#if session.update.state === "ready"}
      <button class="btn warm" id="restart-to-update" title="Version {session.update.version} is downloaded" onclick={() => session.restartToUpdate()} in:fly={{ y: -6, duration: 180 }}>
        <RefreshCw size={15} />Restart to update
      </button>
    {/if}
    <button class="btn primary" onclick={() => session.run("export")} disabled={session.lock !== null}><Download size={15} />Export</button>
  </div>
</header>

<style>
  .titlebar {
    display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px;
    height: 44px; flex: none; background: var(--panel); border-bottom: 1px solid var(--line);
    padding-left: 10px;
    /* Room for the window buttons the OS draws over the bar (Windows/Linux). */
    padding-right: calc(10px + 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));
    -webkit-app-region: drag; user-select: none;
  }
  .titlebar.mac { padding-left: 80px; }
  .titlebar :global(button), .titlebar :global(input) { -webkit-app-region: no-drag; }
  .left, .right { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .right { justify-content: flex-end; gap: 6px; }
  .mark { width: 22px; height: 22px; display: grid; place-items: center; margin-right: 4px; flex: none; }
  .mark svg { width: 22px; height: 22px; display: block; }
  .docname { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: 8px; min-width: 0; }
  .dirty { font-weight: 400; color: var(--muted); }

  .modeswitch { position: relative; display: inline-grid; grid-template-columns: 1fr 1fr; padding: 3px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; }
  .modeswitch button { position: relative; z-index: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 0; background: none; padding: 5px 16px; border-radius: 7px; color: var(--muted); font-weight: 500; transition: color var(--med) var(--ease); }
  .modeswitch button[aria-checked="true"] { color: var(--fg); }
  .modeswitch button[aria-checked="true"] :global(.ico-editor) { color: var(--ink); }
  .modeswitch button[aria-checked="true"] :global(.ico-agent) { color: var(--warm); }
  /* The sliding thumb: one element that moves, so the switch reads as a single control. */
  .thumb { position: absolute; top: 3px; bottom: 3px; left: 3px; width: calc(50% - 3px); background: var(--panel); border-radius: 7px; box-shadow: var(--shadow-sm); transition: transform var(--med) var(--ease); }
  .thumb.agent { transform: translateX(100%); }

  .search { display: inline-flex; align-items: center; gap: 8px; height: 30px; border: 1px solid var(--line); background: var(--panel-2); border-radius: 8px; padding: 0 6px 0 10px; color: var(--muted); min-width: 0; transition: border-color var(--fast); }
  .search:hover { border-color: var(--line-strong); color: var(--fg); }
  @media (max-width: 1100px) { .search .label, .search .kbd { display: none; } }
</style>
