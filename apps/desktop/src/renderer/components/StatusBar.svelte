<script lang="ts">
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import Check from "@lucide/svelte/icons/check";
  import Dot from "@lucide/svelte/icons/dot";
  import { fade } from "../lib/motion.js";
  import { session } from "../lib/session.svelte.js";

  const size = $derived.by(() => {
    void session.docVersion;
    const s = session.editor.intrinsicSize();
    return `${Math.round(s.width)} × ${Math.round(s.height)} px`;
  });
</script>

<footer class="statusbar">
  <span class="msg" class:error={session.status.error}>
    {#key session.status.id}
      <span class="inner" in:fade={{ duration: 140 }}>
        {#if session.status.error}<CircleAlert size={14} />{/if}
        <span id="status" class:error={session.status.error} role="status">{session.status.text}</span>
      </span>
    {/key}
  </span>
  <span class="spacer"></span>
  {#if session.update.state === "downloading"}
    <span class="update" id="update-progress" transition:fade={{ duration: 140 }} title="Downloading version {session.update.version}">
      Updating <span class="bar" aria-hidden="true"><span style:width="{session.update.percent}%"></span></span>{session.update.percent}%
    </span>
  {/if}
  <span>{size}</span>
  <span>{Math.round(session.zoom * 100)}%</span>
  {#if session.dirty}
    <span class="state"><Dot size={16} />Unsaved</span>
  {:else}
    <span class="state saved"><Check size={14} />Saved</span>
  {/if}
</footer>

<style>
  .statusbar { display: flex; align-items: center; gap: 16px; height: 28px; flex: none; padding-inline: 12px; font-size: 12px; color: var(--muted); background: var(--panel); border-top: 1px solid var(--line); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .msg { min-width: 0; display: grid; overflow: hidden; }
  .inner { grid-area: 1 / 1; display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  #status { overflow: hidden; text-overflow: ellipsis; }
  .msg.error { color: var(--err); }
  .state { display: inline-flex; align-items: center; gap: 2px; }
  .update { display: inline-flex; align-items: center; gap: 6px; }
  .bar { width: 60px; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--ink); transition: width var(--med) var(--ease); }
  .saved { color: var(--ok); gap: 4px; }
</style>
