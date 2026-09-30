import { SYSTEM_PROMPT, TOOLS } from "@svg-editor/ai-tools";
import type { AiSettings } from "../../shared/ai.js";
import { PING_TOOL, ProviderError, type Provider, type TurnArgs, type TurnResult } from "./provider.js";

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
type ChatMessage =
  | { role: "system" | "user"; content: string }
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
  const body: Record<string, unknown> = { model: s.model, messages, tools, tool_choice: "auto", max_tokens: maxTokens };
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
    // reported below
  }
  if (!res.ok) {
    const detail = json.error?.message ?? raw.slice(0, 200);
    if (res.status === 401) throw new ProviderError(`The API key was rejected (401). Check the key in AI settings. ${detail}`.trim());
    if (res.status === 404) throw new ProviderError(`Model or endpoint not found (404). Check the model name and base URL. ${detail}`.trim());
    if (res.status === 429) throw new ProviderError(`Rate limited (429). Wait a moment and try again. ${detail}`.trim());
    throw new ProviderError(`API error (${res.status}): ${detail}`);
  }
  if (!json.choices?.[0]?.message) throw new ProviderError(`The server's reply is not a Chat Completions response: ${raw.slice(0, 200)}`);
  return json;
}

export const openaiProvider: Provider = {
  async runTurn(a: TurnArgs): Promise<TurnResult> {
    const tools = TOOLS.map(asFunction);
    const history = a.history as ChatMessage[];
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
        text += msg.content;
        a.onText(msg.content);
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
      for (const call of calls) {
        let input: unknown;
        try {
          input = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
        } catch {
          history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ code: "INVALID_JSON", message: "The tool arguments are not valid JSON.", hint: "Call the tool again with valid JSON arguments.", received: call.function.arguments }) });
          continue;
        }
        const outcome = await a.callTool(call.function.name, input);
        history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }) });
      }
    }
  },

  async test(s, apiKey, signal) {
    const res = await complete(s, apiKey, [
      { role: "system", content: "You are checking a connection. Call the ping tool once, then stop." },
      { role: "user", content: "Call the ping tool." },
    ], [asFunction(PING_TOOL)], signal, 1024);
    const called = res.choices![0]!.message!.tool_calls?.some((c) => c.function.name === PING_TOOL.name) ?? false;
    const model = res.model ?? s.model;
    return called ? `Connected to ${model}. Tool calling works.` : `Connected to ${model}, but it did not call the test tool; drawing may not work with this model.`;
  },
};
