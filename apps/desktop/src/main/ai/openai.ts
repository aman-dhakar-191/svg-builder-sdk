import { SYSTEM_PROMPT, toolsFor } from "@svg-editor/ai-tools/definitions";
import type { AiSettings } from "../../shared/ai.js";
import { NO_VISION_MESSAGE, OLD_SNAPSHOT_TEXT, paragraph, PING_TOOL, ProviderError, TEST_IMAGE_PNG, type Provider, type TurnArgs, type TurnResult } from "./provider.js";

/**
 * OpenAI-compatible Chat Completions (OpenAI, OpenRouter, Ollama, LM Studio,
 * vLLM, ...). Plain fetch: every such server speaks the same wire format, and
 * no vendor SDK is needed for it. Non-streaming: tool loops dominate a turn,
 * and not every compatible server streams tool calls correctly.
 */

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatResponse {
  choices?: { finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null; tool_calls?: ToolCall[] } }[];
  model?: string;
  error?: { message?: string };
}

const DEFAULT_BASE = "https://api.openai.com/v1";
const MAX_TOKENS = 16000;

type FunctionTool = { type: "function"; function: { name: string; description: string; parameters: unknown } };
const asFunction = (t: { name: string; description: string; input_schema: unknown }): FunctionTool => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
});

async function complete(s: AiSettings, apiKey: string | null, messages: ChatMessage[], tools: FunctionTool[], signal: AbortSignal, maxTokens = MAX_TOKENS): Promise<ChatResponse> {
  const base = (s.baseUrl.trim() || DEFAULT_BASE).replace(/\/+$/, "");
  const body: Record<string, unknown> = { model: s.model, messages, tools, tool_choice: "auto", max_tokens: maxTokens, stream: false };
  if (s.effort !== "default") body.reasoning_effort = s.effort;
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new ProviderError(`Could not reach ${base}: ${e instanceof Error ? e.message : String(e)}. Check the base URL and your connection.`);
  }
  const raw = await res.text();
  let json: ChatResponse = {};
  try {
    json = JSON.parse(raw) as ChatResponse;
  } catch {
    // Some gateways stream (SSE) even when asked not to: assemble the chunks.
    if (/^\s*data:/.test(raw)) json = fromStream(raw);
  }
  if (!res.ok) {
    const detail = json.error?.message ?? raw.slice(0, 200);
    if (res.status === 401) throw new ProviderError(`The API key was rejected (401). Check the key in AI settings. ${detail}`.trim());
    if (res.status === 404) throw new ProviderError(`Model or endpoint not found (404). Check the model name and base URL. ${detail}`.trim());
    if (res.status === 429) throw new ProviderError(`Rate limited (429). Wait a moment and try again. ${detail}`.trim());
    throw new ProviderError(`API error (${res.status}): ${detail}`, res.status);
  }
  if (!json.choices?.[0]?.message) throw new ProviderError(`The server's reply is not a Chat Completions response: ${raw.slice(0, 200)}`);
  return json;
}

export const openaiProvider: Provider = {
  async runTurn(a: TurnArgs): Promise<TurnResult> {
    const tools = toolsFor({ vision: a.settings.vision }).map(asFunction);
    const history = a.history as ChatMessage[];
    dropOldImages(history);
    if (history.length === 0) history.push({ role: "system", content: SYSTEM_PROMPT });
    history.push({ role: "user", content: a.userText });
    let text = "";
    let rounds = 0;
    for (;;) {
      const res = await complete(a.settings, a.apiKey, history, tools, a.signal);
      const choice = res.choices![0]!;
      const msg = choice.message!;
      if (msg.refusal || choice.finish_reason === "content_filter") {
        return { status: "refused", text, message: msg.refusal ? `The model declined: ${msg.refusal}` : "The model declined this request." };
      }
      if (msg.content) {
        const d = paragraph(text, msg.content);
        text += d;
        a.onText(d);
      }
      const calls = msg.tool_calls ?? [];
      if (choice.finish_reason === "length") {
        // A truncated tool call must not run.
        history.push({ role: "assistant", content: msg.content ?? null });
        return { status: "limit", text, message: "The reply hit the output limit before it finished. Ask for a smaller change." };
      }
      history.push({ role: "assistant", content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (calls.length === 0) return { status: "done", text };
      if (++rounds > a.maxToolRounds) {
        history.pop();
        return { status: "limit", text, message: `Stopped after ${a.maxToolRounds} rounds of tool calls.` };
      }
      // Tool messages carry text only; snapshots follow in one user message.
      const images: ContentPart[] = [];
      for (const call of calls) {
        let input: unknown;
        try {
          input = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
        } catch {
          history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ code: "INVALID_JSON", message: "The tool arguments are not valid JSON.", hint: "Call the tool again with valid JSON arguments.", received: call.function.arguments }) });
          continue;
        }
        const outcome = await a.callTool(call.function.name, input);
        if (outcome.ok && outcome.image) {
          images.push({ type: "text", text: `Snapshot from tool call ${call.id}:` }, { type: "image_url", image_url: { url: `data:${outcome.image.mediaType};base64,${outcome.image.data}` } });
        }
        const note = outcome.ok && outcome.image ? { ...(outcome.result as object), image: "attached in the next user message" } : null;
        history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome.ok ? (note ?? outcome.result) : { error: outcome.error }) });
      }
      if (images.length) history.push({ role: "user", content: images });
    }
  },

  async listModels(s, apiKey, signal) {
    const base = (s.baseUrl.trim() || DEFAULT_BASE).replace(/\/+$/, "");
    let res: Response;
    try {
      res = await fetch(`${base}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new ProviderError(`Could not reach ${base}: ${e instanceof Error ? e.message : String(e)}.`);
    }
    if (!res.ok) throw new ProviderError(`Listing models failed (${res.status}).`, res.status);
    const json = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }[]; models?: { id?: unknown; name?: unknown }[] };
    // OpenAI shape: { data: [{ id }] }; Ollama's native shape: { models: [{ name }] }.
    const list = json.data ?? json.models ?? [];
    return [...new Set(list.map((m) => (typeof m.id === "string" ? m.id : typeof (m as { name?: unknown }).name === "string" ? (m as { name: string }).name : "")).filter(Boolean))].sort();
  },

  async test(s, apiKey, signal) {
    const system = { role: "system" as const, content: "You are checking a connection. Call the ping tool once, then stop." };
    const res = await complete(s, apiKey, [system, { role: "user", content: "Call the ping tool." }], [asFunction(PING_TOOL)], signal, 1024);
    const called = res.choices![0]!.message!.tool_calls?.some((c) => c.function.name === PING_TOOL.name) ?? false;
    const model = res.model ?? s.model;
    if (!called) return `Connected to ${model}, but it did not call the test tool; drawing may not work with this model.`;
    if (!s.vision) return `Connected to ${model}. Tool calling works.`;
    try {
      await complete(s, apiKey, [system, { role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${TEST_IMAGE_PNG}` } },
        { type: "text", text: "Call the ping tool." },
      ] }], [asFunction(PING_TOOL)], signal, 1024);
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 400 || e.status === 422)) return `Connected to ${model}. Tool calling works, but ${NO_VISION_MESSAGE}`;
      throw e;
    }
    return `Connected to ${model}. Tool calling and images work.`;
  },
};

/** Replaces snapshots from earlier turns with a short note (they are large and stale). */
function dropOldImages(history: ChatMessage[]): void {
  for (const msg of history) {
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    msg.content = msg.content.map((c) => (c.type === "image_url" ? { type: "text" as const, text: OLD_SNAPSHOT_TEXT } : c));
  }
}

interface Chunk {
  model?: string;
  error?: { message?: string };
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

/** Builds a Chat Completions response from a streamed (SSE) body. */
export function fromStream(raw: string): ChatResponse {
  let model: string | undefined;
  let content = "";
  let refusal = "";
  let finish: string | null = null;
  let error: { message?: string } | undefined;
  const calls: ToolCall[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m || m[1]!.trim() === "[DONE]" || !m[1]!.trim()) continue;
    let chunk: Chunk;
    try {
      chunk = JSON.parse(m[1]!) as Chunk;
    } catch {
      continue;
    }
    model ??= chunk.model;
    if (chunk.error) error = chunk.error;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const d = choice.delta ?? {};
    if (d.content) content += d.content;
    if (d.refusal) refusal += d.refusal;
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? calls.length;
      const call = (calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.function.name += tc.function.name;
      if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
    }
  }
  if (error && !content && calls.length === 0) return { error };
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  return {
    ...(model ? { model } : {}),
    choices: [{ finish_reason: finish, message: { content: content || null, ...(refusal ? { refusal } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
  };
}
