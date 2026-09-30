<script lang="ts">
  import { session } from "../lib/session.svelte.js";

  let host: HTMLElement;

  // CodeMirror lives in the session (it outlives mode switches); this pane only hosts its DOM.
  $effect(() => {
    host.append(session.view.dom);
  });
  const readOnly = $derived(session.lock !== null);
</script>

<section class="code" aria-label="SVG code">
  <div class="head">
    <span class="title">Code</span>
    {#if session.codeError}
      <span class="pill err" title={session.codeError}>Error: canvas shows the last good version</span>
    {:else}
      <span class="pill ok">Valid SVG</span>
    {/if}
    <span class="spacer"></span>
    {#if readOnly}<span class="pill">Read-only while the agent works</span>{/if}
  </div>
  <div id="code" bind:this={host}></div>
</section>

<style>
  .code { grid-area: code; background: var(--panel); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .head { display: flex; align-items: center; gap: 8px; height: 38px; padding-inline: 12px; border-bottom: 1px solid var(--line); flex: none; }
  .title { font-weight: 600; }
  .pill { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--line); color: var(--muted); white-space: nowrap; transition: color var(--fast), background var(--fast); }
  .pill.ok { color: var(--ok); }
  .pill.err { color: var(--err); background: var(--err-soft); border-color: transparent; }
  #code { flex: 1; min-height: 0; }
  :global(.app.locked) .code { opacity: 0.85; }
</style>
