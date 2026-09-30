<script lang="ts">
  import Keyboard from "@lucide/svelte/icons/keyboard";
  import Palette from "@lucide/svelte/icons/palette";
  import PenTool from "@lucide/svelte/icons/pen-tool";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import { fade } from "../lib/motion.js";
  import type { AiSettingsUpdate, ApiFormat, Effort } from "../../shared/ai.js";
  import { agent } from "../lib/agent.svelte.js";
  import { COMMANDS, formatKeys, IS_MAC } from "../lib/commands.js";
  import { session, type Theme } from "../lib/session.svelte.js";
  import Dialog from "./Dialog.svelte";

  type Section = "ai" | "appearance" | "editor" | "updates" | "shortcuts";
  let section: Section = $state("ai");

  // Form state, reset from the saved settings each time the dialog opens.
  let format: ApiFormat = $state("anthropic");
  let baseUrl = $state("");
  let model = $state("");
  let effort: Effort = $state("default");
  let vision = $state(true);
  let apiKey = $state("");
  const open = $derived(session.overlay === "settings");

  $effect(() => {
    if (!open) return;
    const s = agent.settings;
    if (!s) return;
    format = s.format;
    baseUrl = s.baseUrl;
    model = s.model;
    effort = s.effort;
    vision = s.vision;
    apiKey = "";
  });

  function form(key?: string | null): AiSettingsUpdate {
    const typed = apiKey.trim();
    return { format, baseUrl: baseUrl.trim(), model: model.trim(), effort, vision, ...(key !== undefined ? { apiKey: key } : typed ? { apiKey: typed } : {}) };
  }
  async function save(e?: Event): Promise<void> {
    e?.preventDefault();
    if (await agent.saveSettings(form())) apiKey = "";
  }
  let modelsTimer: ReturnType<typeof setTimeout> | undefined;
  function endpointChanged(): void {
    clearTimeout(modelsTimer);
    modelsTimer = setTimeout(() => void agent.loadModels(form()), 600);
  }
  const hints = $derived.by(() => {
    const s = agent.settings;
    const out: string[] = [];
    if (s?.keyStorage === "session") out.push("This system has no secure key store: the key is kept only until the app quits.");
    if (format === "openai-compatible") out.push("Local servers (Ollama, LM Studio) usually need no key.");
    if (s?.serverFallback && format === s.format && baseUrl.trim() === s.baseUrl) out.push("Server-side fallback is on: if the model declines a request, Anthropic retries it on another model.");
    return out.join(" ");
  });
  const THEMES: { value: Theme; label: string }[] = [
    { value: "system", label: "Match the system" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
</script>

<Dialog open={open} label="Settings" onclose={() => (session.overlay = null)}>
  <div class="settings">
    <nav aria-label="Settings sections">
      <button aria-current={section === "ai"} onclick={() => (section = "ai")}><Sparkles size={15} />AI model</button>
      <button aria-current={section === "appearance"} onclick={() => (section = "appearance")}><Palette size={15} />Appearance</button>
      <button aria-current={section === "editor"} onclick={() => (section = "editor")}><PenTool size={15} />Editor</button>
      {#if !IS_MAC}<button aria-current={section === "updates"} onclick={() => (section = "updates")}><RefreshCw size={15} />Updates</button>{/if}
      <button aria-current={section === "shortcuts"} onclick={() => (section = "shortcuts")}><Keyboard size={15} />Shortcuts</button>
    </nav>

    <div class="body">
      {#if section === "ai"}
        <form id="ai-settings" autocomplete="off" onsubmit={save} in:fade={{ duration: 120 }}>
          <h2>AI model</h2>
          <label class="row"><span>Provider</span>
            <select class="input" name="format" bind:value={format} onchange={endpointChanged}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai-compatible">OpenAI-compatible (OpenAI, OpenRouter, Ollama, LM Studio…)</option>
            </select>
          </label>
          <label class="row"><span>Endpoint</span>
            <input class="input" name="baseUrl" type="url" spellcheck="false" bind:value={baseUrl} oninput={endpointChanged}
              placeholder={format === "anthropic" ? "https://api.anthropic.com (default)" : "https://api.openai.com/v1 (default)"} />
          </label>
          <label class="row"><span>Model</span>
            <span class="combo">
              <input class="input" name="model" required spellcheck="false" list="ai-models" autocomplete="off" bind:value={model} />
              <button type="button" class="icon-btn boxed" id="ai-models-refresh" aria-label="Load models" title="Load the models this endpoint offers" onclick={() => agent.loadModels(form())}><RefreshCw size={14} class={agent.models.state === "loading" ? "spin" : ""} /></button>
            </span>
            <datalist id="ai-models">{#each agent.models.models as m}<option value={m}></option>{/each}</datalist>
            {#if agent.models.message}<small id="ai-models-status" class:err={agent.models.state === "error"}>{agent.models.message}</small>{/if}
          </label>
          <label class="row"><span>API key</span>
            <input class="input" name="apiKey" type="password" spellcheck="false" bind:value={apiKey} placeholder={agent.settings?.hasKey ? "Saved (leave empty to keep)" : "Not set"} />
            <small>Stored encrypted by your system's keychain; never shown again.</small>
          </label>
          <div class="grid2">
            <label class="row"><span>Effort</span>
              <select class="input" name="effort" bind:value={effort}>
                <option value="default">Model default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
              </select>
            </label>
          </div>
          <label class="check"><input type="checkbox" name="vision" bind:checked={vision} /><span>Model can see images <small>(the agent checks its work with snapshots)</small></span></label>
          {#if hints}<p id="ai-settings-hint" class="hint">{hints}</p>{/if}
          {#if agent.settingsMessage.text}
            <p id="ai-settings-status" role="status" class:err={agent.settingsMessage.error} in:fade={{ duration: 120 }}>{agent.settingsMessage.text}</p>
          {/if}
          <div class="foot">
            {#if agent.settings?.hasKey}<button type="button" class="btn ghost" id="ai-clear-key" onclick={() => agent.saveSettings(form(null))}>Remove key</button>{/if}
            <span class="spacer"></span>
            <button type="button" class="btn" id="ai-test" disabled={agent.testing} onclick={() => agent.test(form())}>Test connection</button>
            <button type="submit" class="btn primary" disabled={agent.running}>Save</button>
          </div>
        </form>
      {:else if section === "appearance"}
        <div class="sec" in:fade={{ duration: 120 }}>
          <h2>Appearance</h2>
          <fieldset>
            <legend class="hint">Theme</legend>
            {#each THEMES as t}
              <label class="radio"><input type="radio" name="theme" value={t.value} checked={session.theme === t.value} onchange={() => session.setTheme(t.value)} />{t.label}</label>
            {/each}
          </fieldset>
        </div>
      {:else if section === "updates"}
        {@const u = session.update}
        <div class="sec" id="updates" in:fade={{ duration: 120 }}>
          <h2>Updates</h2>
          <p class="hint">You have Curvant {session.appVersion}. New versions come from the project's GitHub releases.</p>
          <label class="check"><input type="checkbox" checked={session.updateAutoCheck} onchange={(e) => session.setUpdateAutoCheck((e.target as HTMLInputElement).checked)} /><span>Check for updates when the app starts <small>(downloads in the background; installs when you restart or quit)</small></span></label>
          <p id="update-status" role="status" class:err={u.state === "error"}>
            {#if u.state === "checking"}Checking…
            {:else if u.state === "none"}This is the latest version.
            {:else if u.state === "available"}Version {u.version} is available.
            {:else if u.state === "downloading"}Downloading version {u.version}: {u.percent}%
            {:else if u.state === "ready"}Version {u.version} is ready.
            {:else if u.state === "error" || u.state === "unsupported"}{u.message}
            {/if}
          </p>
          <div class="foot">
            <span class="spacer"></span>
            {#if u.state === "ready"}
              <button type="button" class="btn warm" onclick={() => session.restartToUpdate()}>Restart to update</button>
            {:else}
              <button type="button" class="btn" id="check-updates" disabled={u.state === "checking" || u.state === "downloading"} onclick={() => session.checkForUpdates()}>Check for updates</button>
            {/if}
          </div>
        </div>
      {:else if section === "editor"}
        <div class="sec" in:fade={{ duration: 120 }}>
          <h2>Editor</h2>
          <label class="check"><input type="checkbox" checked={session.grid} onchange={() => session.viewport?.toggleGrid()} /><span>Show grid</span></label>
          <label class="check"><input type="checkbox" checked={session.snap} onchange={() => session.viewport?.toggleSnap()} /><span>Snap to grid</span></label>
          <label class="check"><input type="checkbox" checked={session.snapShapes} onchange={() => session.toggleSnapShapes()} /><span>Snap to shapes <small>(edges and centres of other shapes and the page, with guide lines; hold Alt while dragging to turn it off)</small></span></label>
          <p class="hint">Hold Shift while dragging to keep straight lines and proportions; hold Alt while dragging a path point to move it without its handles.</p>
        </div>
      {:else}
        <div class="sec" in:fade={{ duration: 120 }}>
          <h2>Keyboard shortcuts</h2>
          <table>
            <tbody>
              {#each COMMANDS.filter((c) => c.keys) as c}<tr><td>{c.label}</td><td><span class="kbd">{formatKeys(c.keys!)}</span></td></tr>{/each}
              <tr><td>Select, rectangle, ellipse, line, text tools</td><td><span class="kbd">V</span> <span class="kbd">R</span> <span class="kbd">E</span> <span class="kbd">L</span> <span class="kbd">T</span></td></tr>
              <tr><td>Edit the selected path's points</td><td><span class="kbd">Enter</span></td></tr>
              <tr><td>Pan the canvas</td><td><span class="kbd">Space</span> + drag</td></tr>
              <tr><td>Nudge the selection (×10 with Shift)</td><td><span class="kbd">Arrow keys</span></td></tr>
              <tr><td>Change a number in the code (×10 with Shift, Esc cancels)</td><td><span class="kbd">Alt</span> + drag</td></tr>
              <tr><td>Move without snapping to shapes</td><td><span class="kbd">Alt</span> while dragging</td></tr>
              <tr><td>Add a point / switch corner and smooth (editing points)</td><td>Double-click the outline / a point</td></tr>
              <tr><td>Remove the selected point (editing points)</td><td><span class="kbd">Delete</span></td></tr>
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  </div>
</Dialog>

<style>
  .settings { width: min(720px, 94vw); height: min(560px, 84vh); display: grid; grid-template-columns: 180px 1fr; }
  nav { background: var(--panel-2); border-right: 1px solid var(--line); padding: 12px 8px; display: grid; align-content: start; gap: 2px; }
  nav button { display: flex; align-items: center; gap: 8px; text-align: left; border: 0; background: none; padding: 7px 10px; border-radius: 7px; color: var(--muted); transition: background var(--fast), color var(--fast); }
  nav button:hover { color: var(--fg); }
  nav button[aria-current="true"] { background: var(--panel); color: var(--fg); box-shadow: var(--shadow-sm); }
  .body { padding: 20px 22px; overflow: auto; min-width: 0; }
  form, .sec { display: grid; gap: 14px; align-content: start; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .row { display: grid; gap: 5px; }
  .row > span { font-size: 12px; color: var(--muted); }
  .row small, .check small { color: var(--muted); font-size: 12px; }
  small.err, #ai-settings-status.err { color: var(--err); }
  .combo { display: flex; gap: 6px; }
  .combo .input { flex: 1; }
  .boxed { border: 1px solid var(--line); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .check, .radio { display: flex; align-items: center; gap: 8px; }
  .check input, .radio input { accent-color: var(--ink); width: 16px; height: 16px; }
  fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: 8px; }
  #ai-settings-status { margin: 0; font-size: 12px; color: var(--ok); }
  #update-status { margin: 0; min-height: 1.4em; }
  #update-status.err { color: var(--err); }
  .foot { display: flex; gap: 8px; align-items: center; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 6px 0; border-bottom: 1px solid var(--line); }
  td:last-child { text-align: right; white-space: nowrap; }
</style>
