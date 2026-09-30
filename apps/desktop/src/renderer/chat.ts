import { dispatch, turnContext } from "@svg-editor/ai-tools";
import { SvgEditorError, type Editor, type LockSession } from "@svg-editor/sdk";
import type { AiRunResult, AiSettingsUpdate, AiSettingsView, AiToolCall, ApiFormat, Effort } from "../shared/ai.js";
import type { AiApi } from "../shared/api.js";

/**
 * AI side chat. The main process talks to the model; this side runs each
 * tool call against the document through the SDK, inside one lock session
 * per turn. So a turn is one undo step, the user cannot edit mid-turn, and
 * Stop (the lock banner) discards the turn and cancels the request.
 */

const TURN_TIMEOUT_MS = 10 * 60_000;

interface Turn {
  id: string;
  session: LockSession;
  reply: HTMLElement;
  tools: HTMLElement;
}

interface Options {
  api: AiApi;
  editor: () => Editor;
  /** Pushes pending code-pane typing into the model before a turn starts. */
  flush: () => void;
  status: (text: string, error: boolean) => void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class ChatPanel {
  private turn: Turn | null = null;
  private settings: AiSettingsView | null = null;
  private readonly log = $<HTMLDivElement>("chat-log");
  private readonly input = $<HTMLTextAreaElement>("chat-input");
  private readonly sendButton = $<HTMLButtonElement>("chat-send");
  private readonly form = $<HTMLFormElement>("ai-settings");

  constructor(private readonly o: Options) {
    o.api.onEvent((e) => {
      if (!this.turn || e.turnId !== this.turn.id) return;
      if (e.type === "text") this.turn.reply.textContent += e.delta;
      else this.note(e.message);
      this.scroll();
    });
    o.api.onToolCall((call) => this.runTool(call));

    $("chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    $("chat-new").addEventListener("click", () => void this.newChat());
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.saveSettings();
    });
    $("ai-test").addEventListener("click", () => void this.testConnection());
    $("ai-clear-key").addEventListener("click", () => void this.saveSettings(null));
    this.field<HTMLSelectElement>("format").addEventListener("change", () => this.updateHints());
    this.field<HTMLInputElement>("baseUrl").addEventListener("input", () => this.updateHints());
    void this.loadSettings();
  }

  get running(): boolean {
    return this.turn !== null;
  }

  // ------------------------------------------------------------------ turns

  private async send(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.turn) return;
    const editor = this.o.editor();
    if (editor.lockInfo) {
      this.o.status(`${editor.lockInfo.label} Wait until it finishes.`, true);
      return;
    }
    if (this.settings && !this.settings.hasKey && this.settings.format === "anthropic") {
      this.openSettings("Add an API key to start.");
      return;
    }
    this.o.flush();
    this.input.value = "";
    this.message("user", text);
    const reply = this.message("assistant", "");
    const tools = document.createElement("ul");
    tools.className = "chat-tools";
    reply.before(tools);
    const id = crypto.randomUUID();
    const root = editor.doc.getNode(editor.doc.root);
    const context = turnContext({ selection: editor.getSelection(), size: editor.intrinsicSize(), viewBox: root.attrs.viewBox ?? null });
    this.setBusy(true);
    let result: AiRunResult | null = null;
    try {
      await editor.runLocked({ reason: "ai", label: "AI is drawing…", timeoutMs: TURN_TIMEOUT_MS }, async (session) => {
        this.turn = { id, session, reply, tools };
        // Stop in the lock banner (or the timeout) cancels the model request too.
        session.signal.addEventListener("abort", () => this.o.api.stop(), { once: true });
        result = await this.o.api.run(id, text + context);
        // The result carries the whole reply; streamed deltas may still be in flight.
        if (result.text.length >= (reply.textContent ?? "").length) reply.textContent = result.text;
        // Anything but a finished turn is rolled back: the conversation forgets it too.
        if (result.status !== "done") throw new TurnEnded();
      });
      this.o.status("AI turn finished. One Ctrl+Z removes all of it.", false);
    } catch (e) {
      const r = result as AiRunResult | null;
      const stopped = e instanceof SvgEditorError && e.code === "LOCK_STOPPED";
      if (stopped || r?.status === "stopped") this.note("Stopped.");
      else if (r && r.status !== "done") this.note(r.message ?? "The turn did not finish.", r.status === "error");
      else this.note(e instanceof Error ? e.message : String(e), true);
      if (r && r.status !== "done" && !stopped) this.o.status("The AI turn did not finish; its changes were discarded.", true);
    } finally {
      this.turn = null;
      if (!reply.textContent) reply.remove();
      if (!tools.childElementCount) tools.remove();
      this.setBusy(false);
      this.input.focus();
    }
  }

  private runTool(call: AiToolCall): void {
    const t = this.turn;
    if (!t || call.turnId !== t.id || !t.session.active) {
      this.o.api.sendToolResult(call.callId, { ok: false, error: { code: "STOPPED", message: "The turn has ended.", hint: "Do not continue." } });
      return;
    }
    const s = t.session;
    const outcome = dispatch({ doc: s.doc, editor: this.o.editor(), batch: (fn) => s.batch(fn) }, call.name, call.input);
    this.o.api.sendToolResult(call.callId, outcome);
    const li = document.createElement("li");
    li.className = outcome.ok ? "ok" : "error";
    li.textContent = outcome.ok ? toolLabel(call.name) : `${toolLabel(call.name)}: ${outcome.error.message}`;
    li.title = JSON.stringify(call.input).slice(0, 500);
    t.tools.append(li);
    this.scroll();
  }

  private async newChat(): Promise<void> {
    if (this.turn) return;
    if (await this.o.api.reset()) this.log.replaceChildren();
  }

  private setBusy(busy: boolean): void {
    this.sendButton.disabled = busy;
    this.input.disabled = busy;
    $<HTMLButtonElement>("chat-new").disabled = busy;
    for (const el of this.form.elements) (el as HTMLButtonElement).disabled = busy;
    document.body.classList.toggle("ai-running", busy);
  }

  private message(role: "user" | "assistant", text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = `chat-msg ${role}`;
    el.textContent = text;
    this.log.append(el);
    this.scroll();
    return el;
  }

  private note(text: string, error = false): void {
    const el = document.createElement("div");
    el.className = `chat-note${error ? " error" : ""}`;
    el.textContent = text;
    this.log.append(el);
    this.scroll();
  }

  private scroll(): void {
    this.log.scrollTop = this.log.scrollHeight;
  }

  // --------------------------------------------------------------- settings

  private field<T extends HTMLElement>(name: string): T {
    return this.form.elements.namedItem(name) as T;
  }

  private async loadSettings(): Promise<void> {
    this.showSettings(await this.o.api.getSettings());
    if (!this.settings!.hasKey && this.settings!.format === "anthropic") this.openSettings("Add an API key to start.");
  }

  private showSettings(v: AiSettingsView): void {
    this.settings = v;
    const { format, baseUrl, model, effort } = v;
    this.field<HTMLSelectElement>("format").value = format;
    this.field<HTMLInputElement>("baseUrl").value = baseUrl;
    this.field<HTMLInputElement>("model").value = model;
    this.field<HTMLSelectElement>("effort").value = effort;
    const key = this.field<HTMLInputElement>("apiKey");
    key.value = "";
    key.placeholder = v.hasKey ? "Saved (leave empty to keep)" : "Not set";
    $<HTMLButtonElement>("ai-clear-key").hidden = !v.hasKey;
    this.updateHints();
  }

  private readForm(key?: string | null): AiSettingsUpdate {
    const typed = this.field<HTMLInputElement>("apiKey").value.trim();
    return {
      format: this.field<HTMLSelectElement>("format").value as ApiFormat,
      baseUrl: this.field<HTMLInputElement>("baseUrl").value.trim(),
      model: this.field<HTMLInputElement>("model").value.trim(),
      effort: this.field<HTMLSelectElement>("effort").value as Effort,
      ...(key !== undefined ? { apiKey: key } : typed ? { apiKey: typed } : {}),
    };
  }

  private async saveSettings(key?: null): Promise<void> {
    try {
      this.showSettings(await this.o.api.saveSettings(this.readForm(key)));
      this.settingsStatus(key === null ? "API key removed." : "Saved.", false);
    } catch (e) {
      this.settingsStatus(ipcMessage(e), true);
    }
  }

  private async testConnection(): Promise<void> {
    const button = $<HTMLButtonElement>("ai-test");
    button.disabled = true;
    this.settingsStatus("Testing…", false);
    try {
      const r = await this.o.api.test(this.readForm());
      this.settingsStatus(r.message, !r.ok);
    } catch (e) {
      this.settingsStatus(ipcMessage(e), true);
    } finally {
      button.disabled = false;
    }
  }

  private settingsStatus(text: string, error: boolean): void {
    const el = $("ai-settings-status");
    el.textContent = text;
    el.classList.toggle("error", error);
  }

  private openSettings(message: string): void {
    $<HTMLDetailsElement>("ai-settings-box").open = true;
    this.settingsStatus(message, false);
  }

  private updateHints(): void {
    const format = this.field<HTMLSelectElement>("format").value as ApiFormat;
    const base = this.field<HTMLInputElement>("baseUrl");
    base.placeholder = format === "anthropic" ? "https://api.anthropic.com (default)" : "https://api.openai.com/v1 (default)";
    const v = this.settings;
    const hints: string[] = [];
    if (v?.keyStorage === "session") hints.push("This system has no secure key store: the key is kept only until the app quits.");
    if (format === "openai-compatible") hints.push("Local servers (Ollama, LM Studio) usually need no key.");
    if (v?.serverFallback && format === v.format && base.value.trim() === v.baseUrl) {
      hints.push("Server-side fallback is on: if the model declines a request, Anthropic retries it on another model.");
    }
    $("ai-settings-hint").textContent = hints.join(" ");
  }
}

class TurnEnded extends Error {}

function toolLabel(name: string): string {
  return name.replace(/_/g, " ");
}

/** Errors thrown in the main process arrive as "Error invoking remote method '…': Error: <message>". */
function ipcMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
