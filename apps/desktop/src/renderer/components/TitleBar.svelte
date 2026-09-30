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
    <span class="mark" aria-hidden="true">
      <svg viewBox="0 0 16 16"><path d="M3 12.5 8 3l5 9.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /><circle cx="8" cy="3" r="1.7" fill="var(--ink)" /></svg>
    </span>
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
  .mark { width: 22px; height: 22px; border-radius: 6px; background: var(--fg); color: var(--panel); display: grid; place-items: center; margin-right: 4px; flex: none; }
  .mark svg { width: 14px; height: 14px; }
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
