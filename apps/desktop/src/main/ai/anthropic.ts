import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, toolsFor, validate } from "@svg-editor/ai-tools";
import type { AiSettings } from "../../shared/ai.js";
import { NO_VISION_MESSAGE, OLD_SNAPSHOT_TEXT, PING_TOOL, ProviderError, TEST_IMAGE_PNG, type Provider, type TurnArgs, type TurnResult } from "./provider.js";

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;
type ContentParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type Tools = NonNullable<Params["tools"]>;

const MAX_TOKENS = 32000;
/** Models that accept `fallbacks: "default"` on the official API. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const JSON_RETRIES = 2;

/** True when requests go to Anthropic's own API, where beta fields are known to be accepted. */
export function isOfficialEndpoint(baseUrl: string): boolean {
  if (!baseUrl.trim()) return true;
  try {
    return new URL(baseUrl).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

/** Server-side fallback is on for these settings (the UI tells the user). */
export function usesFallback(s: AiSettings): boolean {
  return isOfficialEndpoint(s.baseUrl) && FALLBACK_MODELS.has(s.model);
}

function client(s: AiSettings, apiKey: string | null): Anthropic {
  if (!apiKey) throw new ProviderError("No API key is set. Add one in AI settings.");
  return new Anthropic({ apiKey, ...(s.baseUrl.trim() ? { baseURL: s.baseUrl.trim() } : {}), maxRetries: 2 });
}

function requestParams(s: AiSettings, messages: Params["messages"], tools: Tools): Params {
  const official = isOfficialEndpoint(s.baseUrl);
  const params: Params = {
    model: s.model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    // Eager streaming only on the official API: proxies and some gateways reject the field.
    tools: official ? tools.map((t) => ({ ...t, eager_input_streaming: true })) : tools,
    messages,
    ...(s.effort !== "default" ? { output_config: { effort: s.effort } } : {}),
  };
  if (usesFallback(s)) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = "default";
  }
  return params;
}

/** Streams one request; retries when the SDK cannot parse a streamed tool input. */
async function streamOnce(c: Anthropic, params: Params, signal: AbortSignal, onText: (d: string) => void): Promise<Message> {
  for (let attempt = 0; ; attempt++) {
    const stream = c.beta.messages.stream(params, { signal });
    let emitted = false;
    stream.on("text", (d) => {
      emitted = true;
      onText(d);
    });
    try {
      return await stream.finalMessage();
    } catch (e) {
      // Only the SDK's JSON error is retried; typed API errors propagate.
      if (e instanceof Anthropic.APIError || e instanceof Anthropic.APIUserAbortError || signal.aborted) throw e;
      if (!(e instanceof Error) || !/json/i.test(e.message) || attempt >= JSON_RETRIES) throw e;
      if (emitted) onText("\n");
    }
  }
}

export function toProviderError(e: unknown): unknown {
  if (e instanceof ProviderError || e instanceof Anthropic.APIUserAbortError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new ProviderError("The API key was rejected (401). Check the key in AI settings.");
  if (e instanceof Anthropic.PermissionDeniedError) return new ProviderError("This key is not allowed to use that model or endpoint (403).");
  if (e instanceof Anthropic.NotFoundError) return new ProviderError("Model or endpoint not found (404). Check the model name and base URL.");
  if (e instanceof Anthropic.RateLimitError) return new ProviderError("Rate limited (429). Wait a moment and try again.");
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError(`Could not reach the API: ${e.message}. Check the base URL and your connection.`);
  if (e instanceof Anthropic.BadRequestError) return new ProviderError(`The API rejected the request (400): ${e.message}`);
  if (e instanceof Anthropic.APIError) return new ProviderError(`API error${e.status ? ` (${e.status})` : ""}: ${e.message}`);
  return e;
}

function textOf(m: Message): string {
  return m.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export const anthropicProvider: Provider = {
  async runTurn(a: TurnArgs): Promise<TurnResult> {
    try {
      const c = client(a.settings, a.apiKey);
      const tools = toolsFor({ vision: a.settings.vision }).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) as Tools;
      const history = a.history as Params["messages"];
      dropOldImages(history);
      history.push({ role: "user", content: a.userText });
      let text = "";
      let rounds = 0;
      for (;;) {
        const m = await streamOnce(c, requestParams(a.settings, history, tools), a.signal, (d) => {
          text += d;
          a.onText(d);
        });
        if (m.stop_reason === "refusal") {
          // A refusal can cut a tool call off mid-input: never run this turn's tools.
          const why = m.stop_details?.explanation;
          return { status: "refused", text, message: why ? `The model declined: ${why}` : "The model declined this request." };
        }
        history.push({ role: "assistant", content: m.content as ContentParam[] });
        if (m.stop_reason === "pause_turn") continue;
        if (m.stop_reason === "max_tokens") {
          return { status: "limit", text, message: "The reply hit the output limit before it finished. Ask for a smaller change." };
        }
        const calls = m.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
        if (m.stop_reason !== "tool_use" || calls.length === 0) return { status: "done", text: text || textOf(m) };
        if (++rounds > a.maxToolRounds) {
          history.pop(); // leave no unanswered tool_use in the history
          return { status: "limit", text, message: `Stopped after ${a.maxToolRounds} rounds of tool calls.` };
        }
        const results: ToolResult[] = [];
        for (const call of calls) {
          const outcome = await a.callTool(call.name, call.input);
          if (!outcome.ok) results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: JSON.stringify(outcome.error) });
          else if (outcome.image) {
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: [
                { type: "text", text: JSON.stringify(outcome.result) },
                { type: "image", source: { type: "base64", media_type: outcome.image.mediaType, data: outcome.image.data } },
              ],
            });
          } else results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(outcome.result) });
        }
        history.push({ role: "user", content: results });
      }
    } catch (e) {
      throw toProviderError(e);
    }
  },

  async listModels(s, apiKey, signal) {
    try {
      const ids: string[] = [];
      for await (const m of client(s, apiKey).models.list({ limit: 100 }, { signal })) {
        ids.push(m.id);
        if (ids.length >= 500) break;
      }
      return ids;
    } catch (e) {
      throw toProviderError(e);
    }
  },

  async test(s, apiKey, signal) {
    try {
      const c = client(s, apiKey);
      const params = requestParams(s, [{ role: "user", content: "Call the ping tool." }], [PING_TOOL]);
      params.max_tokens = 1024;
      params.system = "You are checking a connection. Call the ping tool once, then stop.";
      const m = await streamOnce(c, params, signal, () => {});
      const called = m.content.some((b) => b.type === "tool_use" && b.name === PING_TOOL.name && validate(b.input, PING_TOOL.input_schema) === null);
      const fallback = usesFallback(s) ? " Server-side fallback is on: if this model declines a request, Anthropic retries it on another model." : "";
      if (!called) return `Connected to ${m.model}, but it did not call the test tool; drawing may not work with this model.`;
      if (s.vision) {
        const img = requestParams(s, [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: TEST_IMAGE_PNG } },
          { type: "text", text: "Call the ping tool." },
        ] }], [PING_TOOL]);
        img.max_tokens = 1024;
        img.system = params.system;
        try {
          await streamOnce(c, img, signal, () => {});
        } catch (e) {
          if (e instanceof Anthropic.BadRequestError) return `Connected to ${m.model}. Tool calling works, but ${NO_VISION_MESSAGE}`;
          throw e;
        }
        return `Connected to ${m.model}. Tool calling and images work.${fallback}`;
      }
      return `Connected to ${m.model}. Tool calling works.${fallback}`;
    } catch (e) {
      throw toProviderError(e);
    }
  },
};

/** Replaces images in earlier turns' tool results with a short note (they are large and stale). */
function dropOldImages(history: Params["messages"]): void {
  for (const msg of history) {
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      block.content = block.content.map((c) => (c.type === "image" ? { type: "text" as const, text: OLD_SNAPSHOT_TEXT } : c));
    }
  }
}
