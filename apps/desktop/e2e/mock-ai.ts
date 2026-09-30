import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Scripted stand-ins for the Anthropic Messages API (SSE streaming) and an
 * OpenAI-compatible Chat Completions API, so the app's real provider code runs
 * end to end without a network or a key.
 */

export type Step =
  | { text?: string; tools?: { name: string; input: unknown }[] }
  | { status: number; error: string }
  /** Never answers; the request stays open until the client aborts it. */
  | { hang: true };

export interface Recorded {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
  /** Resolves when the client closes the connection before a reply. */
  aborted: Promise<void>;
}

export class MockAi {
  readonly requests: Recorded[] = [];
  /** Answer Chat Completions as SSE even when stream: false (some gateways do). */
  openaiStreams = false;
  /** Model IDs for GET .../models. */
  models = ["mock-model-a", "mock-model-b"];
  /** GET .../models requests (kept apart so `requests` stays one entry per model call). */
  readonly modelRequests: { path: string; headers: IncomingMessage["headers"] }[] = [];
  private steps: Step[] = [];
  private gates: (Promise<void> | undefined)[] = [];
  private server!: Server;

  /** Queues replies, one per request. A gate delays a reply until it resolves. */
  script(steps: Step[], gates: (Promise<void> | undefined)[] = []): void {
    this.steps = [...steps];
    this.gates = [...gates];
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = (req.url ?? "").split("?")[0]!;
    if (req.method === "GET" && path.endsWith("/models")) {
      this.modelRequests.push({ path, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      const data = path.startsWith("/v1/models")
        ? this.models.map((id) => ({ id, type: "model", display_name: id, created_at: "2026-01-01T00:00:00Z" }))
        : this.models.map((id) => ({ id, object: "model" }));
      return void res.end(JSON.stringify({ data, has_more: false, first_id: this.models[0] ?? null, last_id: this.models.at(-1) ?? null }));
    }
    let closed!: () => void;
    const aborted = new Promise<void>((r) => (closed = r));
    res.on("close", () => {
      if (!res.writableEnded) closed();
    });
    this.requests.push({ path: req.url ?? "", headers: req.headers, body: (raw ? JSON.parse(raw) : {}) as Record<string, unknown>, aborted });
    const step = this.steps.shift();
    const gate = this.gates.shift();
    if (gate) await gate;
    if (!step) return void res.writeHead(500).end("mock: no scripted reply left");
    if ("hang" in step) return;
    if ("status" in step) {
      res.writeHead(step.status, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ type: "error", error: { type: "error", message: step.error }, message: step.error }));
    }
    if (path.endsWith("/v1/messages")) this.anthropic(res, step);
    else if (path.endsWith("/chat/completions")) this.openai(res, step);
    else res.writeHead(404).end();
  }

  private anthropic(res: ServerResponse, step: { text?: string; tools?: { name: string; input: unknown }[] }): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const n = this.requests.length;
    send("message_start", {
      message: { id: `msg_${n}`, type: "message", role: "assistant", model: "mock-claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
    });
    let index = 0;
    if (step.text) {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      for (const part of step.text.match(/.{1,12}/gs) ?? []) send("content_block_delta", { index, delta: { type: "text_delta", text: part } });
      send("content_block_stop", { index });
      index++;
    }
    for (const [k, t] of (step.tools ?? []).entries()) {
      send("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${n}_${k}`, name: t.name, input: {} } });
      const json = JSON.stringify(t.input);
      for (let i = 0; i < json.length; i += 40) send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 40) } });
      send("content_block_stop", { index });
      index++;
    }
    send("message_delta", { delta: { stop_reason: step.tools?.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
    send("message_stop", {});
    res.end();
  }

  private openai(res: ServerResponse, step: { text?: string; tools?: { name: string; input: unknown }[] }): void {
    const n = this.requests.length;
    const tool_calls = (step.tools ?? []).map((t, k) => ({ id: `call_${n}_${k}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input) } }));
    if (this.openaiStreams) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id: `chatcmpl_${n}`, object: "chat.completion.chunk", model: "mock-gpt", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: "assistant" });
      for (const part of step.text?.match(/.{1,5}/gs) ?? []) chunk({ content: part });
      tool_calls.forEach((c, index) => {
        chunk({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.function.name, arguments: "" } }] });
        for (let i = 0; i < c.function.arguments.length; i += 30) chunk({ tool_calls: [{ index, function: { arguments: c.function.arguments.slice(i, i + 30) } }] });
      });
      chunk({}, tool_calls.length ? "tool_calls" : "stop");
      return void res.end("data: [DONE]\n\n");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `chatcmpl_${n}`,
        object: "chat.completion",
        model: "mock-gpt",
        choices: [{ index: 0, finish_reason: tool_calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: step.text ?? null, ...(tool_calls.length ? { tool_calls } : {}) } }],
      }),
    );
  }
}

/** A promise plus the function that resolves it. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}
