import { dispatch, turnContext } from "@svg-editor/ai-tools";
import { SvgEditorError, type LockSession } from "@svg-editor/sdk";
import type { AiRunResult, AiSettingsUpdate, AiSettingsView, AiToolCall } from "../../shared/ai.js";
import { session } from "./session.svelte.js";

/*
 * Agent mode: the main process talks to the model; this side runs each tool
 * call against the document through the SDK, inside one lock session per
 * turn. So a turn is one undo step, the user cannot edit mid-turn, and Stop
 * (the lock banner) discards the turn and cancels the request.
 */

const TURN_TIMEOUT_MS = 10 * 60_000;
/** render_snapshot calls allowed per turn: enough to check and fix, not enough to loop. */
const SNAPSHOTS_PER_TURN = 6;

export interface Step {
  name: string;
  /** Short summary of the input, for the tooltip. */
  input: string;
  state: "running" | "ok" | "error";
  error?: string;
  /** data: URL of a snapshot the agent looked at. */
  image?: string;
}

export interface Turn {
  id: string;
  prompt: string;
  steps: Step[];
  reply: string;
  notes: { text: string; error: boolean }[];
  status: "running" | "done" | "stopped" | "failed";
  startedAt: number;
  endedAt?: number;
  /** Document version right after this turn was committed: "Undo this turn" needs it unchanged. */
  endVersion?: number;
  undone?: boolean;
}

export interface ModelList {
  state: "idle" | "loading" | "ok" | "error";
  models: string[];
  message: string;
}

class Agent {
  turns: Turn[] = $state([]);
  draft = $state("");
  settings: AiSettingsView | null = $state(null);
  /** Last settings message ("Saved.", test results, errors). */
  settingsMessage = $state({ text: "", error: false });
  models: ModelList = $state({ state: "idle", models: [], message: "" });
  testing = $state(false);

  private live: { turn: Turn; lock: LockSession; snapshotBudget: { left: number } } | null = null;
  private modelsRequest = 0;

  get running(): boolean {
    return this.turns.at(-1)?.status === "running";
  }
  get needsKey(): boolean {
    return !!this.settings && !this.settings.hasKey && this.settings.format === "anthropic";
  }

  start(): void {
    const api = window.desktop?.ai;
    if (!api) return;
    api.onEvent((e) => {
      const t = this.live?.turn;
      if (!t || e.turnId !== t.id) return;
      if (e.type === "text") t.reply += e.delta;
      else t.notes.push({ text: e.message, error: false });
    });
    api.onToolCall((call) => void this.runTool(call));
    void this.loadSettings();
  }

  // ------------------------------------------------------------ turns

  async send(): Promise<void> {
    const text = this.draft.trim();
    const api = window.desktop?.ai;
    if (!text || this.running || !api) return;
    const editor = session.editor;
    if (editor.lockInfo) return session.showStatus(`${editor.lockInfo.label} Wait until it finishes.`, true);
    if (this.needsKey) {
      this.settingsMessage = { text: "Add an API key to start.", error: false };
      session.overlay = "settings";
      return;
    }
    session.flush();
    this.draft = "";
    const turn: Turn = { id: crypto.randomUUID(), prompt: text, steps: [], reply: "", notes: [], status: "running", startedAt: Date.now() };
    this.turns.push(turn);
    const t = this.turns.at(-1)!; // the reactive proxy
    const root = editor.doc.getNode(editor.doc.root);
    const context = turnContext({ selection: editor.getSelection(), size: editor.intrinsicSize(), viewBox: root.attrs.viewBox ?? null });
    let result: AiRunResult | null = null;
    try {
      await editor.runLocked({ reason: "ai", label: "Agent is drawing · editing is paused", timeoutMs: TURN_TIMEOUT_MS }, async (lock) => {
        this.live = { turn: t, lock, snapshotBudget: { left: SNAPSHOTS_PER_TURN } };
        // Stop in the lock banner (or the timeout) cancels the model request too.
        lock.signal.addEventListener("abort", () => api.stop(), { once: true });
        result = await api.run(t.id, text + context);
        // The result carries the whole reply; streamed deltas may still be in flight.
        if (result.text.length >= t.reply.length) t.reply = result.text;
        // Anything but a finished turn is rolled back: the conversation forgets it too.
        if (result.status !== "done") throw new TurnEnded();
      });
      t.status = "done";
      t.endVersion = session.docVersion;
      session.showStatus("Agent turn finished. One Ctrl+Z removes all of it.", false);
    } catch (e) {
      const r = result as AiRunResult | null;
      const stopped = e instanceof SvgEditorError && e.code === "LOCK_STOPPED";
      if (stopped || r?.status === "stopped") {
        t.status = "stopped";
        t.notes.push({ text: "Stopped.", error: false });
      } else {
        t.status = "failed";
        if (r && r.status !== "done") t.notes.push({ text: r.message ?? "The turn did not finish.", error: r.status === "error" });
        else t.notes.push({ text: e instanceof Error ? e.message : String(e), error: true });
        if (r) session.showStatus("The agent's turn did not finish; its changes were discarded.", true);
      }
    } finally {
      t.endedAt = Date.now();
      for (const s of t.steps) {
        if (s.state !== "running") continue;
        s.state = "error";
        s.error = "Did not finish: the turn ended first.";
      }
      this.live = null;
    }
  }

  private async runTool(call: AiToolCall): Promise<void> {
    const api = window.desktop.ai;
    const live = this.live;
    if (!live || call.turnId !== live.turn.id || !live.lock.active) {
      api.sendToolResult(call.callId, { ok: false, error: { code: "STOPPED", message: "The turn has ended.", hint: "Do not continue." } });
      return;
    }
    live.turn.steps.push({ name: call.name, input: JSON.stringify(call.input).slice(0, 400), state: "running" });
    const step = live.turn.steps.at(-1)!;
    const s = live.lock;
    const outcome = await dispatch({ doc: s.doc, editor: session.editor, batch: (fn) => s.batch(fn), snapshotBudget: live.snapshotBudget }, call.name, call.input);
    api.sendToolResult(call.callId, outcome);
    step.state = outcome.ok ? "ok" : "error";
    if (!outcome.ok) step.error = outcome.error.message;
    else if (outcome.image) step.image = `data:${outcome.image.mediaType};base64,${outcome.image.data}`;
  }

  /** Undoes a finished turn, if nothing changed the drawing since. */
  canUndo(t: Turn): boolean {
    return t.status === "done" && !t.undone && t.endVersion === session.docVersion && session.lock === null;
  }
  undoTurn(t: Turn): void {
    if (!this.canUndo(t)) return;
    session.undo();
    t.undone = true;
  }

  async newChat(): Promise<void> {
    if (this.running) return;
    if (await window.desktop.ai.reset()) this.turns = [];
  }

  // ------------------------------------------------------------ settings

  async loadSettings(): Promise<void> {
    const v = await window.desktop.ai.getSettings();
    this.settings = v;
    if (v.hasKey || v.format === "openai-compatible") void this.loadModels(v);
  }

  async saveSettings(update: AiSettingsUpdate): Promise<boolean> {
    try {
      this.settings = await window.desktop.ai.saveSettings(update);
      this.settingsMessage = { text: update.apiKey === null ? "API key removed." : "Saved.", error: false };
      if (typeof update.apiKey === "string" && update.apiKey) void this.loadModels(update);
      return true;
    } catch (e) {
      this.settingsMessage = { text: ipcMessage(e), error: true };
      return false;
    }
  }

  async test(update: AiSettingsUpdate): Promise<void> {
    this.testing = true;
    this.settingsMessage = { text: "Testing…", error: false };
    try {
      const r = await window.desktop.ai.test(update);
      this.settingsMessage = { text: r.message, error: !r.ok };
    } catch (e) {
      this.settingsMessage = { text: ipcMessage(e), error: true };
    } finally {
      this.testing = false;
    }
  }

  /** Fills the model combo box with what the endpoint offers; typing any name still works. */
  async loadModels(update: AiSettingsUpdate): Promise<void> {
    const n = ++this.modelsRequest;
    this.models = { state: "loading", models: this.models.models, message: "Loading models…" };
    let r: { ok: boolean; models: string[]; message?: string };
    try {
      r = await window.desktop.ai.listModels(update);
    } catch (e) {
      r = { ok: false, models: [], message: ipcMessage(e) };
    }
    if (n !== this.modelsRequest) return; // a newer request superseded this one
    this.models = r.ok
      ? { state: "ok", models: r.models, message: r.models.length ? `${r.models.length} models available: pick one or type a name.` : "The endpoint listed no models; type a name." }
      : { state: "error", models: [], message: r.message ?? "Could not list models." };
  }
}

class TurnEnded extends Error {}

export function toolLabel(name: string): string {
  return name.replace(/_/g, " ");
}

/** Errors thrown in the main process arrive as "Error invoking remote method '…': Error: <message>". */
function ipcMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export const agent = new Agent();
