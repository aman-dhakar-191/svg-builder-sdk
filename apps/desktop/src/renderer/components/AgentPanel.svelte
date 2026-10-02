<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Check from "@lucide/svelte/icons/check";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CodeXml from "@lucide/svelte/icons/code-xml";
  import Crosshair from "@lucide/svelte/icons/crosshair";
  import Eye from "@lucide/svelte/icons/eye";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import SquarePen from "@lucide/svelte/icons/square-pen";
  import Square from "@lucide/svelte/icons/square";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import X from "@lucide/svelte/icons/x";
  import { onMount, tick } from "svelte";
  import { fade, fly, slide } from "../lib/motion.js";
  import { agent, toolLabel, type Turn } from "../lib/agent.svelte.js";
  import { session } from "../lib/session.svelte.js";

  const EXAMPLES = ["Draw a simple house with a red door", "Make a round badge with a crescent moon", "Add a soft shadow under the selected shape"];

  let log: HTMLElement;
  let input: HTMLTextAreaElement;
  let collapsed = $state(new Set<string>());

  onMount(() => agent.start());

  // A clock for the running turn's elapsed time.
  let now = $state(Date.now());
  $effect(() => {
    if (!agent.running) return;
    const timer = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(timer);
  });

  /** What the agent is doing right now, from its streamed progress. */
  function liveLabel(t: Turn): string {
    const w = t.writing;
    if (w) {
      const size = w.chars < 1024 ? `${w.chars} B` : `${(w.chars / 1024).toFixed(1)} KB`;
      if (w.tool === "add_elements") return w.shapes ? `Drawing · ${w.shapes} shape${w.shapes === 1 ? "" : "s"} so far · ${size}` : `Drawing · ${size}`;
      return `${toolLabel(w.tool)} · ${size}`;
    }
    const step = t.steps.at(-1);
    if (step?.state === "running") return `${toolLabel(step.name)}…`;
    return t.steps.length ? "Thinking about the next step" : "Planning the design";
  }

  // Follow the conversation as it grows (new steps, streamed text), unless the user scrolled up.
  let pinned = true;
  $effect(() => {
    const last = agent.turns.at(-1);
    void last?.reply;
    void last?.steps.length;
    void last?.notes.length;
    void agent.turns.length;
    if (pinned) tick().then(() => log?.scrollTo({ top: log.scrollHeight }));
  });
  // Focus the prompt when switching to Agent mode.
  $effect(() => {
    if (session.mode === "agent") tick().then(() => input?.focus());
  });

  const selectionLabel = $derived.by(() => {
    void session.docVersion;
    const ids = session.selection.filter((id) => session.editor.doc.has(id));
    if (ids.length === 0) return null;
    if (ids.length > 1) return `${ids.length} shapes`;
    const n = session.editor.doc.getNode(ids[0]!);
    return n.attrs.id ? `#${n.attrs.id}` : `<${n.tag}>`;
  });

  function seconds(t: Turn): string {
    return `${Math.max(1, Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 1000))} s`;
  }
  function toggle(id: string): void {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void agent.send();
    }
  }
</script>

<section class="chat" aria-label="Agent">
  <div class="head">
    <span class="title">Agent</span>
    <button class="model" onclick={() => (session.overlay = "settings")} title="Change the model">{agent.settings?.model ?? "…"}</button>
    <span class="spacer"></span>
    <button class="icon-btn" id="chat-new" aria-label="New conversation" title="New conversation (the drawing is kept)" disabled={agent.running} onclick={() => agent.newChat()}><SquarePen size={16} /></button>
  </div>

  <div id="chat-log" class="log" bind:this={log} onscroll={() => (pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 40)} aria-live="polite">
    {#if agent.turns.length === 0}
      <div class="welcome" in:fade={{ duration: 200 }}>
        <span class="badge"><Sparkles size={18} /></span>
        <h2>Describe what to draw or change</h2>
        <p>The agent edits this drawing step by step and checks its work. You can stop it at any time, and one Ctrl+Z undoes a whole turn.</p>
        {#if agent.needsKey}
          <button class="btn primary" onclick={() => (session.overlay = "settings")}><KeyRound size={15} />Connect a model</button>
        {:else}
          <div class="examples">
            {#each EXAMPLES as ex}
              <button onclick={() => { agent.draft = ex; input.focus(); }}>{ex}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#each agent.turns as t (t.id)}
      <div class="chat-msg user" in:fly={{ y: 8, duration: 180 }}>{t.prompt}</div>
      <div class="turn" in:fade={{ duration: 160 }}>
        <div class="turn-head">
          <span class="agent-dot" class:busy={t.status === "running"}>{#if t.status === "running"}<LoaderCircle size={12} class="spin" />{:else}<Sparkles size={12} />{/if}</span>
          {#if t.status === "running"}
            <span class="live-label" id="agent-live">{liveLabel(t)}</span><span class="elapsed">{Math.max(0, Math.round((now - t.startedAt) / 1000))} s</span>
          {:else}
          <span>{t.status === "done" ? `${t.steps.length} step${t.steps.length === 1 ? "" : "s"} · ${seconds(t)}` : t.status === "stopped" ? "Stopped" : "Did not finish"}</span>
          {/if}
        </div>

        {#if t.steps.length}
          <div class="steps">
            <button class="steps-head" aria-expanded={!collapsed.has(t.id)} onclick={() => toggle(t.id)}>
              <span class="chev" class:open={!collapsed.has(t.id)}><ChevronRight size={14} /></span>
              {t.status === "running" ? "Working on the drawing" : "Worked on the drawing"}
              {#if t.steps.some((s) => s.state === "error")}
                {@const failed = t.steps.filter((s) => s.state === "error").length}
                <span class="failed">· {failed} step{failed === 1 ? "" : "s"} failed</span>
              {/if}
            </button>
            {#if !collapsed.has(t.id)}
              <ul class="chat-tools" transition:slide={{ duration: 160 }}>
                {#each t.steps as s}
                  <li class={s.state === "error" ? "error" : s.state === "ok" ? "ok" : "running"} title={s.input} in:fly={{ x: -6, duration: 160 }}>
                    <span class="state" aria-hidden="true">{#if s.state === "running"}<LoaderCircle size={13} class="spin" />{:else if s.state === "ok"}<Check size={13} />{:else}<X size={13} />{/if}</span>{toolLabel(s.name)}{#if s.error}<span class="step-error">{s.error}</span>{/if}{#if s.image}<img class="chat-snapshot" alt="Snapshot the agent looked at" src={s.image} />{/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}

        {#if t.reply}<div class="chat-msg assistant">{t.reply}</div>{/if}
        {#each t.notes as n}<div class="chat-note" class:error={n.error} in:fade={{ duration: 150 }}>{n.text}</div>{/each}

        {#if t.status === "done"}
          <div class="actions" in:fade={{ duration: 160 }}>
            <button class="btn small" disabled={!agent.canUndo(t)} title={t.undone ? "Undone" : agent.canUndo(t) ? "Remove everything this turn did" : "The drawing changed since; use Ctrl+Z"} onclick={() => agent.undoTurn(t)}><Undo2 size={14} />{t.undone ? "Undone" : "Undo this turn"}</button>
            <button class="btn small" onclick={() => session.setMode("editor")}><CodeXml size={14} />Open in editor</button>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <form id="chat-form" class="composer" onsubmit={(e) => { e.preventDefault(); void agent.send(); }}>
    <div class="box" class:busy={agent.running}>
      <textarea id="chat-input" bind:this={input} bind:value={agent.draft} rows="2" disabled={agent.running} onkeydown={onKeydown}
        placeholder={agent.running ? "The agent is working. Press Stop on the canvas to cancel." : "Describe a change, e.g. “draw a simple house with a red door”"}></textarea>
      <div class="row">
        {#if agent.settings?.vision}<span class="chip on" title="The agent looks at snapshots of its work"><Eye size={13} />Checks its work</span>{/if}
        {#if selectionLabel}<span class="chip" title="The agent knows what is selected" in:fade={{ duration: 120 }}><Crosshair size={13} />{selectionLabel}</span>{/if}
        <span class="spacer"></span>
        {#if agent.running}
          <button type="button" class="send stop" id="chat-stop" aria-label="Stop" title="Stop and discard this turn" onclick={() => session.stopLock(false)}><Square size={13} /></button>
        {:else}
          <button type="submit" class="send" id="chat-send" aria-label="Send" title="Send (Enter)" disabled={!agent.draft.trim()}><ArrowUp size={16} /></button>
        {/if}
      </div>
    </div>
  </form>
</section>

<style>
  .chat { grid-area: chat; background: var(--panel); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .head { display: flex; align-items: center; gap: 8px; height: 38px; padding-inline: 12px; border-bottom: 1px solid var(--line); flex: none; }
  .title { font-weight: 600; }
  .model { font: 11px var(--f-mono); border: 1px solid var(--line); background: var(--panel-2); border-radius: 999px; padding: 1px 8px; color: var(--muted); }
  .model:hover { color: var(--fg); border-color: var(--line-strong); }
  .log { flex: 1; min-height: 0; overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }

  .welcome { margin: auto 0; display: grid; gap: 10px; justify-items: start; max-width: 420px; padding: 8px; }
  .welcome h2 { margin: 0; font-size: 17px; font-weight: 600; text-wrap: balance; }
  .welcome p { margin: 0; color: var(--muted); }
  .badge { width: 34px; height: 34px; border-radius: 10px; background: var(--warm-soft); color: var(--warm); display: grid; place-items: center; }
  .examples { display: grid; gap: 6px; margin-top: 4px; }
  .examples button { text-align: left; border: 1px dashed var(--line-strong); background: none; border-radius: 10px; padding: 7px 12px; color: var(--muted); transition: border-color var(--fast), color var(--fast), background var(--fast); }
  .examples button:hover { border-color: var(--warm); color: var(--fg); background: var(--warm-soft); }

  .chat-msg.user { align-self: flex-end; max-width: 85%; background: var(--panel-2); border: 1px solid var(--line); border-radius: 12px 12px 4px 12px; padding: 8px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .turn { display: grid; gap: 8px; }
  .turn-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
  .agent-dot { width: 20px; height: 20px; border-radius: 6px; background: var(--warm); color: #fff; display: grid; place-items: center; flex: none; }
  :global(.spin) { animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .live-label {
    background: linear-gradient(90deg, var(--muted) 0%, var(--muted) 35%, var(--fg) 50%, var(--muted) 65%, var(--muted) 100%);
    background-size: 250% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: shimmer 1.8s linear infinite;
  }
  .elapsed { margin-left: auto; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  @keyframes shimmer { from { background-position: 100% 0; } to { background-position: -150% 0; } }
  @media (prefers-reduced-motion: reduce) { .live-label { animation: none; color: var(--muted); background: none; } }
  .steps { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .steps-head { width: 100%; display: flex; align-items: center; gap: 6px; border: 0; background: var(--panel-2); padding: 7px 10px; color: var(--muted); font-size: 12px; text-align: left; }
  .steps-head:hover { color: var(--fg); }
  .chev { display: inline-grid; transition: transform var(--fast) var(--ease); }
  .chev.open { transform: rotate(90deg); }
  .chat-tools { margin: 0; padding: 6px 10px 8px; list-style: none; display: grid; gap: 4px; font-size: 12px; }
  .chat-tools li { display: flex; flex-wrap: wrap; align-items: center; gap: 0 6px; overflow-wrap: anywhere; }
  .chat-tools .state { display: inline-grid; }
  .chat-tools li.ok .state { color: var(--ok); }
  .chat-tools li.error { color: var(--err); }
  .step-error { flex-basis: 100%; margin: 2px 0 2px 19px; padding: 4px 8px; border-radius: 6px; background: var(--err-soft); color: var(--err); }
  .failed { color: var(--err); }
  .chat-tools li.running .state { color: var(--warm); }
  .chat-snapshot { flex-basis: 100%; display: block; max-width: 180px; max-height: 150px; margin: 4px 0 2px 19px; border-radius: 8px; border: 1px solid var(--line); background: #fff; }
  .chat-msg.assistant { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
  .chat-note { font-size: 12px; color: var(--muted); }
  .chat-note.error { color: var(--err); }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }

  .composer { border-top: 1px solid var(--line); padding: 10px 12px 12px; flex: none; }
  .box { border: 1px solid var(--line); border-radius: 12px; background: var(--panel-2); padding: 8px 10px; display: grid; gap: 8px; transition: border-color var(--fast), box-shadow var(--fast); }
  .box:focus-within { border-color: var(--warm); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warm) 15%, transparent); }
  .box.busy { opacity: 0.8; }
  textarea { border: 0; background: none; resize: none; outline: none; min-height: 44px; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 2px 9px; color: var(--muted); }
  .chip.on { color: var(--ink); border-color: color-mix(in srgb, var(--ink) 40%, var(--line)); }
  .send { width: 32px; height: 32px; border-radius: 9px; border: 0; background: var(--warm); color: #fff; display: grid; place-items: center; transition: transform var(--fast), opacity var(--fast); }
  .send:hover:not(:disabled) { transform: translateY(-1px); }
  .send:disabled { opacity: 0.4; }
  .send.stop { background: var(--fg); color: var(--panel); }
</style>
