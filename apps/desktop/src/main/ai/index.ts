import { ipcMain, type WebContents } from "electron";
import type { AiEvent, AiRunResult, AiSettings, AiTestResult, AiToolCall, AiToolOutcome } from "../../shared/ai.js";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import { ProviderError, type Provider } from "./provider.js";
import { getApiKey, getSettings, parseUpdate, saveSettings, view } from "./settings.js";

/**
 * AI side chat, main-process half: holds the API key and the conversation,
 * talks to the provider, and asks the renderer to run each tool call against
 * the document (the renderer owns the editor; it applies calls inside its
 * lock session). The key never reaches the renderer.
 */

const MAX_TOOL_ROUNDS = 30;
const TOOL_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;

interface Conversation {
  /** Identifies the provider + endpoint + model the history was made with. */
  key: string;
  history: unknown[];
  run: AbortController | null;
}

const conversations = new Map<number, Conversation>();
const pending = new Map<string, { sender: WebContents; resolve: (o: AiToolOutcome) => void; timer: NodeJS.Timeout }>();
let callSeq = 0;

const providerFor = (s: AiSettings): Provider => (s.format === "anthropic" ? anthropicProvider : openaiProvider);
const conversationKey = (s: AiSettings): string => `${s.format}\n${s.baseUrl}\n${s.model}`;

function conversation(sender: WebContents): Conversation {
  let c = conversations.get(sender.id);
  if (!c) {
    c = { key: conversationKey(getSettings()), history: [], run: null };
    conversations.set(sender.id, c);
    sender.once("destroyed", () => {
      c!.run?.abort();
      conversations.delete(sender.id);
      for (const [id, p] of pending) if (p.sender === sender) settle(id, stoppedOutcome);
    });
  }
  return c;
}

const stoppedOutcome: AiToolOutcome = { ok: false, error: { code: "STOPPED", message: "The user stopped the turn.", hint: "Do not continue." } };

function settle(callId: string, outcome: AiToolOutcome): void {
  const p = pending.get(callId);
  if (!p) return;
  pending.delete(callId);
  clearTimeout(p.timer);
  p.resolve(outcome);
}

function callTool(sender: WebContents, turnId: string, signal: AbortSignal, name: string, input: unknown): Promise<AiToolOutcome> {
  if (signal.aborted || sender.isDestroyed()) return Promise.resolve(stoppedOutcome);
  const callId = `call_${++callSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => settle(callId, { ok: false, error: { code: "TIMEOUT", message: "The editor did not answer in time.", hint: "Try again." } }),
      TOOL_TIMEOUT_MS,
    );
    pending.set(callId, { sender, resolve, timer });
    signal.addEventListener("abort", () => settle(callId, stoppedOutcome), { once: true });
    const call: AiToolCall = { turnId, callId, name, input };
    sender.send("ai:toolCall", call);
  });
}

function emit(sender: WebContents, event: AiEvent): void {
  if (!sender.isDestroyed()) sender.send("ai:event", event);
}

export function registerAiIpc(): void {
  ipcMain.handle("ai:getSettings", () => view());

  ipcMain.handle("ai:saveSettings", async (e, raw: unknown) => {
    const saved = await saveSettings(parseUpdate(raw));
    const c = conversation(e.sender);
    // A different model or endpoint cannot continue another one's history.
    if (!c.run && c.key !== conversationKey(saved)) {
      c.key = conversationKey(saved);
      c.history = [];
    }
    return saved;
  });

  ipcMain.handle("ai:test", async (_e, raw: unknown): Promise<AiTestResult> => {
    let update;
    try {
      update = parseUpdate(raw);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    const key = typeof update.apiKey === "string" && update.apiKey ? update.apiKey : update.apiKey === null ? null : getApiKey();
    if (update.format === "anthropic" && !key) return { ok: false, message: "Enter an API key first." };
    const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
    try {
      return { ok: true, message: await providerFor(update).test(update, key, signal) };
    } catch (err) {
      if (signal.aborted) return { ok: false, message: `No answer within ${TEST_TIMEOUT_MS / 1000} seconds.` };
      return { ok: false, message: err instanceof ProviderError ? err.message : `Unexpected error: ${(err as Error).message}` };
    }
  });

  ipcMain.handle("ai:listModels", async (_e, raw: unknown): Promise<{ ok: boolean; models: string[]; message?: string }> => {
    let update;
    try {
      update = parseUpdate(raw);
    } catch (err) {
      return { ok: false, models: [], message: (err as Error).message };
    }
    const key = typeof update.apiKey === "string" && update.apiKey ? update.apiKey : update.apiKey === null ? null : getApiKey();
    if (update.format === "anthropic" && !key) return { ok: false, models: [], message: "Enter an API key to list models." };
    try {
      return { ok: true, models: await providerFor(update).listModels(update, key, AbortSignal.timeout(TEST_TIMEOUT_MS)) };
    } catch (err) {
      return { ok: false, models: [], message: err instanceof ProviderError ? err.message : `Could not list models: ${(err as Error).message}` };
    }
  });

  ipcMain.handle("ai:run", async (e, turnId: unknown, userText: unknown): Promise<AiRunResult> => {
    if (typeof turnId !== "string" || typeof userText !== "string" || !userText.trim()) throw new Error("ai:run: bad arguments");
    const sender = e.sender;
    const c = conversation(sender);
    if (c.run) return { status: "error", text: "", message: "A turn is already running." };
    const settings = getSettings();
    const apiKey = getApiKey();
    if (settings.format === "anthropic" && !apiKey) return { status: "error", text: "", message: "No API key is set. Add one in AI settings." };
    if (c.key !== conversationKey(settings)) {
      c.key = conversationKey(settings);
      c.history = [];
    }
    const controller = new AbortController();
    c.run = controller;
    const start = c.history.length;
    let text = "";
    let result: AiRunResult;
    try {
      const r = await providerFor(settings).runTurn({
        settings,
        apiKey,
        userText,
        history: c.history,
        signal: controller.signal,
        maxToolRounds: MAX_TOOL_ROUNDS,
        callTool: (name, input) => callTool(sender, turnId, controller.signal, name, input),
        onText: (delta) => {
          text += delta;
          emit(sender, { turnId, type: "text", delta });
        },
      });
      result = controller.signal.aborted ? { status: "stopped", text } : { status: r.status, text: r.text, ...(r.message ? { message: r.message } : {}) };
    } catch (err) {
      if (controller.signal.aborted) result = { status: "stopped", text };
      else if (err instanceof ProviderError) result = { status: "error", text, message: err.message };
      else result = { status: "error", text, message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      c.run = null;
    }
    // Only a finished turn is kept: the renderer discards the drawing changes
    // of any other outcome, so the model must not remember making them.
    if (result.status !== "done") c.history.length = start;
    return result;
  });

  ipcMain.on("ai:stop", (e) => conversations.get(e.sender.id)?.run?.abort());

  ipcMain.on("ai:toolResult", (e, callId: unknown, outcome: unknown) => {
    if (typeof callId !== "string") return;
    const p = pending.get(callId);
    if (!p || p.sender !== e.sender) return;
    const o = outcome as AiToolOutcome | null;
    settle(callId, o && typeof o === "object" && typeof o.ok === "boolean" ? o : { ok: false, error: { code: "INTERNAL", message: "Malformed tool result.", hint: "Try again." } });
  });

  ipcMain.handle("ai:reset", (e) => {
    const c = conversation(e.sender);
    if (c.run) return false;
    c.history = [];
    return true;
  });
}
