<script lang="ts">
  import AgentPanel from "./components/AgentPanel.svelte";
  import CodePane from "./components/CodePane.svelte";
  import CommandPalette from "./components/CommandPalette.svelte";
  import Inspector from "./components/Inspector.svelte";
  import Rail from "./components/Rail.svelte";
  import SettingsDialog from "./components/SettingsDialog.svelte";
  import Stage from "./components/Stage.svelte";
  import StartScreen from "./components/StartScreen.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import TitleBar from "./components/TitleBar.svelte";
  import { commandForKey } from "./lib/commands.js";
  import { session } from "./lib/session.svelte.js";

  /** App-wide shortcuts. Editors (CodeMirror, text fields) keep their own undo. */
  function onKeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const action = commandForKey(e);
    if (!action) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable);
    if (typing && (action === "undo" || action === "redo")) return;
    e.preventDefault();
    session.run(action);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app" data-mode={session.mode} class:locked={session.lock !== null}>
  <TitleBar />
  <div class="workspace">
    <Rail />
    <CodePane />
    <Stage />
    <Inspector />
    <AgentPanel />
  </div>
  <StatusBar />
</div>

<CommandPalette />
<SettingsDialog />
<StartScreen />

<style>
  .app { height: 100%; display: flex; flex-direction: column; background: var(--panel-2); }
  .workspace { flex: 1; min-height: 0; display: grid; }
  .app[data-mode="editor"] .workspace {
    grid-template-columns: 48px minmax(260px, 0.95fr) minmax(360px, 1.7fr) 292px;
    grid-template-areas: "rail code canvas inspector";
  }
  .app[data-mode="agent"] .workspace {
    grid-template-columns: minmax(360px, 0.95fr) minmax(380px, 1.4fr);
    grid-template-areas: "chat canvas";
  }
  /* Panels of the other mode stay mounted (code, chat and scroll positions survive a switch). */
  .app[data-mode="agent"] .workspace > :global(:is(.rail, .code, .inspector)),
  .app[data-mode="editor"] .workspace > :global(.chat) { display: none; }
</style>
