import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gate, MockAi } from "./mock-ai.js";

let app: ElectronApplication;
let page: Page;
let mock: MockAi;
let baseUrl: string;
let userData: string;

const KEY = "sk-test-0123456789";

test.beforeEach(async () => {
  mock = new MockAi();
  baseUrl = await mock.start();
  userData = mkdtempSync(join(tmpdir(), "svg-editor-e2e-"));
  app = await electron.launch({
    args: [fileURLToPath(new URL("../out/main/index.cjs", import.meta.url)), "--no-sandbox"],
    env: { ...process.env, SVG_EDITOR_USER_DATA: userData },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.waitForSelector("#canvas svg");
  await page.locator("#tab-ai-button").click();
});

test.afterEach(async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
  await app.close();
  await mock.stop();
  rmSync(userData, { recursive: true, force: true });
});

const code = () => page.evaluate(() => (window as unknown as { editor: { view: { state: { doc: { toString(): string } } } } }).editor.view.state.doc.toString());

async function configure(format: "anthropic" | "openai-compatible", model: string, key = KEY, vision = true): Promise<void> {
  const box = page.locator("#ai-settings-box");
  if (!(await box.evaluate((d) => (d as HTMLDetailsElement).open))) await page.locator("#ai-settings-box summary").click();
  await page.locator('#ai-settings [name="format"]').selectOption(format);
  await page.locator('#ai-settings [name="baseUrl"]').fill(format === "anthropic" ? baseUrl : `${baseUrl}/v1`);
  await page.locator('#ai-settings [name="model"]').fill(model);
  await page.locator('#ai-settings [name="vision"]').setChecked(vision);
  if (key) await page.locator('#ai-settings [name="apiKey"]').fill(key);
  await page.locator('#ai-settings button[type="submit"]').click();
  await expect(page.locator("#ai-settings-status")).toHaveText("Saved.");
}

async function ask(text: string): Promise<void> {
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-send").click();
}

const HOUSE = {
  elements: [
    { tag: "g", attributes: { id: "house" } },
    { tag: "rect", parent: "$0", attributes: { x: 60, y: 50, width: 80, height: 45, fill: "#fde68a", stroke: "#78350f" } },
    { tag: "polygon", parent: "$0", attributes: { points: "55,50 100,20 145,50", fill: "#b91c1c" } },
    { tag: "rect", parent: "$0", attributes: { id: "door", x: 92, y: 70, width: 16, height: 25, fill: "#dc2626" } },
  ],
};

test("acceptance (Anthropic): a house with a red door, locked while drawing, one Ctrl+Z removes it", async () => {
  await configure("anthropic", "claude-test-model");
  const original = await code();
  const hold = gate();
  mock.script(
    [
      { text: "Let me look at the drawing.", tools: [{ name: "get_document", input: {} }] },
      { tools: [{ name: "add_elements", input: HOUSE }] },
      { text: "I drew a simple house with a red door." },
    ],
    [undefined, undefined, hold.promise],
  );
  await ask("draw a simple house with a red door");

  // Mid-turn: the house is on the canvas, the editor is locked for the user.
  await expect(page.locator("#canvas svg #door")).toHaveCount(1);
  await expect(page.locator("#lock-banner")).toBeVisible();
  await expect(page.locator("#lock-label")).toHaveText("AI is drawing…");
  await expect(page.locator('.toolbar [data-tool="rect"]')).toBeDisabled();
  await expect(page.locator("#chat-send")).toBeDisabled();
  hold.open();

  await expect(page.locator(".chat-msg.assistant").last()).toHaveText("Let me look at the drawing.\n\nI drew a simple house with a red door.");
  await expect(page.locator("#lock-banner")).toBeHidden();
  await expect(page.locator(".chat-tools li")).toHaveText(["get document", "add elements"]);

  // Valid SVG with a red door, reported back to the model as tool results.
  const svg = await code();
  expect(svg).toMatch(/<rect id="door"[^>]*fill="#dc2626"/);
  await page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    if (doc.querySelector("parsererror")) throw new Error("invalid SVG");
  }, svg);

  // What the API saw: key header, model, stable system prompt, tools, full history.
  expect(mock.requests).toHaveLength(3);
  const [first, second, third] = mock.requests.map((r) => r.body) as Record<string, unknown>[];
  expect(mock.requests[0]!.headers["x-api-key"]).toBe(KEY);
  expect(first).toMatchObject({ model: "claude-test-model", stream: true });
  expect(first!.system).toMatch(/drawing assistant inside an SVG editor/);
  expect((first!.tools as { name: string; eager_input_streaming?: boolean }[]).map((t) => t.name)).toContain("add_elements");
  // A custom base URL may be a proxy: no beta-only fields.
  expect((first!.tools as { eager_input_streaming?: boolean }[]).every((t) => t.eager_input_streaming === undefined)).toBe(true);
  expect(first!.fallbacks).toBeUndefined();
  expect(JSON.stringify((first!.messages as unknown[])[0])).toContain("[Editor context: viewBox 0 0 200 120");
  const secondMessages = second!.messages as { role: string; content: { type: string; is_error?: boolean; content?: string }[] }[];
  expect(secondMessages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(secondMessages[2]!.content[0]).toMatchObject({ type: "tool_result" });
  expect(secondMessages[2]!.content[0]!.content).toContain('"viewBox":"0 0 200 120"');
  expect((third!.messages as unknown[]).length).toBe(5);

  // One undo step for the whole turn.
  await page.locator("#canvas").focus();
  await page.keyboard.press("Control+z");
  await expect.poll(code).toBe(original);
});

test("acceptance (OpenAI-compatible): same turn through Chat Completions", async () => {
  await configure("openai-compatible", "gpt-test");
  const original = await code();
  mock.script([{ tools: [{ name: "add_elements", input: HOUSE }] }, { text: "Done: a house with a red door." }]);
  await ask("draw a simple house with a red door");
  await expect(page.locator(".chat-msg.assistant").last()).toHaveText("Done: a house with a red door.");
  await expect(page.locator("#lock-banner")).toBeHidden();
  expect(await code()).toMatch(/<rect id="door"[^>]*fill="#dc2626"/);

  expect(mock.requests[0]!.path).toBe("/v1/chat/completions");
  expect(mock.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  const second = mock.requests[1]!.body.messages as { role: string; tool_call_id?: string; content: string }[];
  expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  expect(JSON.parse(second[3]!.content)).toMatchObject({ ids: expect.any(Array) });

  await page.locator("#canvas").focus();
  await page.keyboard.press("Control+z");
  await expect.poll(code).toBe(original);
});

test("tool errors go back to the model, which corrects itself", async () => {
  await configure("anthropic", "claude-test-model");
  mock.script([
    { tools: [{ name: "set_attributes", input: { id: "n_999", attributes: { fill: "red" } } }] },
    { tools: [{ name: "add_elements", input: { elements: [{ tag: "circle", attributes: { id: "fixed", r: 5 } }] } }] },
    { text: "Fixed." },
  ]);
  await ask("make it red");
  await expect(page.locator(".chat-msg.assistant").last()).toHaveText("Fixed.");
  await expect(page.locator(".chat-tools li.error")).toContainText("set attributes");
  const result = (mock.requests[1]!.body.messages as { content: { is_error?: boolean; content: string }[] }[])[2]!.content[0]!;
  expect(result.is_error).toBe(true);
  expect(JSON.parse(result.content)).toMatchObject({ code: "NOT_FOUND", hint: expect.any(String) });
  expect(await code()).toContain('id="fixed"');
});

test("Stop cancels the request, discards the turn and the conversation forgets it", async () => {
  await configure("anthropic", "claude-test-model");
  const original = await code();
  mock.script([{ tools: [{ name: "add_elements", input: HOUSE }] }, { hang: true }]);
  await ask("draw a house");
  await expect(page.locator("#canvas svg #door")).toHaveCount(1);
  await expect.poll(() => mock.requests.length).toBe(2);
  await page.locator("#lock-stop").click();

  await mock.requests[1]!.aborted; // the in-flight HTTP request was cancelled
  await expect(page.locator("#lock-banner")).toBeHidden();
  await expect.poll(code).toBe(original);
  await expect(page.locator(".chat-note").last()).toHaveText("Stopped.");
  await expect(page.locator("#chat-send")).toBeEnabled();

  mock.script([{ text: "Hi." }]);
  await ask("hello");
  await expect(page.locator(".chat-msg.assistant").last()).toHaveText("Hi.");
  const messages = mock.requests[2]!.body.messages as { role: string; content: unknown }[];
  expect(messages).toHaveLength(1); // the stopped turn is not in the history
  expect(JSON.stringify(messages[0]!.content)).toContain("hello");
});

test("API errors are shown, nothing changes, the editor unlocks", async () => {
  await configure("anthropic", "claude-test-model");
  const original = await code();
  mock.script([{ status: 401, error: "invalid x-api-key" }]);
  await ask("draw a house");
  await expect(page.locator(".chat-note.error")).toContainText("The API key was rejected (401)");
  await expect(page.locator("#lock-banner")).toBeHidden();
  expect(await code()).toBe(original);

  // An error after the model already drew: the partial turn is rolled back.
  mock.script([{ tools: [{ name: "add_elements", input: HOUSE }] }, { status: 400, error: "bad request" }]);
  await ask("draw a house");
  await expect(page.locator(".chat-note.error").last()).toContainText("The API rejected the request (400)");
  await expect(page.locator("#lock-banner")).toBeHidden();
  await expect.poll(code).toBe(original);
  await expect(page.locator("#status")).toContainText("discarded");
});

test("settings: test connection, key never returned to the page or written in plain text", async () => {
  await configure("anthropic", "claude-test-model");
  mock.script([{ tools: [{ name: "ping", input: {} }] }, { tools: [{ name: "ping", input: {} }] }]);
  await page.locator("#ai-test").click();
  await expect(page.locator("#ai-settings-status")).toHaveText("Connected to mock-claude. Tool calling and images work.");
  // The second request checked image input with a small PNG.
  expect(JSON.stringify(mock.requests[1]!.body.messages)).toContain('"type":"image"');

  const view = await page.evaluate(() => (window as unknown as { desktop: { ai: { getSettings(): Promise<unknown> } } }).desktop.ai.getSettings());
  expect(view).toMatchObject({ format: "anthropic", model: "claude-test-model", hasKey: true });
  expect(JSON.stringify(view)).not.toContain(KEY);
  expect(readFileSync(join(userData, "ai-settings.json"), "utf8")).not.toContain(KEY);
  await expect(page.locator('#ai-settings [name="apiKey"]')).toHaveValue("");

  // Bad input is refused by the main process with a readable message.
  await page.locator('#ai-settings [name="baseUrl"]').fill("ftp://example.com");
  await page.locator('#ai-settings button[type="submit"]').click();
  await expect(page.locator("#ai-settings-status")).toHaveText("The base URL must start with https:// or http://.");
});

test("OpenAI-compatible servers work without a key; a missing Anthropic key opens settings", async () => {
  await page.locator('#ai-settings [name="format"]').selectOption("anthropic");
  await ask("hi");
  await expect(page.locator("#ai-settings-status")).toHaveText("Add an API key to start.");
  expect(mock.requests).toHaveLength(0);

  await configure("openai-compatible", "local-model", "");
  mock.script([{ text: "Hello from a local model." }]);
  await ask("hi");
  await expect(page.locator(".chat-msg.assistant").last()).toHaveText("Hello from a local model.");
  expect(mock.requests[0]!.headers.authorization).toBeUndefined();
});

const PNG_B64 = /^iVBORw0KGgo/;

test("vision loop (Anthropic): the AI takes a snapshot, sees it in the tool result, earlier snapshots are dropped", async () => {
  await configure("anthropic", "claude-test-model");
  mock.script([
    { tools: [{ name: "add_elements", input: HOUSE }] },
    { tools: [{ name: "render_snapshot", input: {} }] },
    { text: "Checked: the house looks right." },
  ]);
  await ask("draw a simple house with a red door and check it");
  await expect(page.locator(".chat-msg.assistant").last()).toHaveText("Checked: the house looks right.");
  await expect(page.locator(".chat-tools li")).toHaveText(["add elements", "render snapshot"]);
  await expect(page.locator(".chat-snapshot")).toHaveCount(1);
  expect((mock.requests[0]!.body.tools as { name: string }[]).map((t) => t.name)).toContain("render_snapshot");

  const third = mock.requests[2]!.body.messages as { role: string; content: { type: string; content?: { type: string; source?: { data: string } }[] }[] }[];
  const result = third.at(-1)!.content[0]!;
  expect(result.type).toBe("tool_result");
  const image = result.content!.find((c) => c.type === "image")!;
  expect(image.source!.data).toMatch(PNG_B64);
  expect(JSON.parse((result.content![0] as unknown as { text: string }).text)).toMatchObject({ width: expect.any(Number), region: "whole page" });

  // Next turn: the old snapshot is replaced by a note, not re-sent.
  mock.script([{ text: "Ok." }]);
  await ask("thanks");
  await expect(page.locator(".chat-msg.assistant").last()).toHaveText("Ok.");
  const sent = JSON.stringify(mock.requests[3]!.body.messages);
  expect(sent).not.toContain('"type":"image"');
  expect(sent).toContain("snapshot from an earlier turn omitted");
});

test("vision loop (OpenAI-compatible): snapshot goes in a user message after the tool result", async () => {
  await configure("openai-compatible", "gpt-test");
  mock.script([{ tools: [{ name: "render_snapshot", input: {} }] }, { text: "Looks fine." }]);
  await ask("how does it look?");
  await expect(page.locator(".chat-msg.assistant").last()).toHaveText("Looks fine.");
  const msgs = mock.requests[1]!.body.messages as { role: string; content: unknown }[];
  expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
  expect(JSON.parse(msgs[3]!.content as string)).toMatchObject({ image: "attached in the next user message" });
  const parts = msgs[4]!.content as { type: string; image_url?: { url: string } }[];
  expect(parts.find((p) => p.type === "image_url")!.image_url!.url).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
});

test("models without image input: no snapshot tool, and Test connection says so", async () => {
  await configure("anthropic", "claude-test-model", KEY, false);
  mock.script([{ text: "Hi." }]);
  await ask("hi");
  await expect(page.locator(".chat-msg.assistant").last()).toHaveText("Hi.");
  expect((mock.requests[0]!.body.tools as { name: string }[]).map((t) => t.name)).not.toContain("render_snapshot");

  await configure("anthropic", "claude-test-model", KEY, true);
  mock.script([{ tools: [{ name: "ping", input: {} }] }, { status: 400, error: "image input is not supported" }]);
  await page.locator("#ai-test").click();
  await expect(page.locator("#ai-settings-status")).toContainText("this model does not accept images");
});

test("OpenAI-compatible gateway that streams even when asked not to", async () => {
  await configure("openai-compatible", "claude-code");
  mock.openaiStreams = true;
  mock.script([{ text: "Drawing.", tools: [{ name: "add_elements", input: HOUSE }] }, { text: "Done: a house with a red door." }]);
  await ask("draw a simple house with a red door");
  await expect(page.locator(".chat-msg.assistant").last()).toHaveText("Drawing.\n\nDone: a house with a red door.");
  expect(await code()).toMatch(/<rect id="door"[^>]*fill="#dc2626"/);
  expect(mock.requests[0]!.body.stream).toBe(false);
});

test("model picker lists the endpoint's models (both formats); any name can still be typed", async () => {
  mock.models = ["gpt-a", "claude-code", "llama-3"];
  await configure("openai-compatible", "claude-code");
  await expect(page.locator("#ai-models-status")).toHaveText("3 models available: pick one or type a name.");
  await expect(page.locator("#ai-models option")).toHaveCount(3);
  expect(await page.locator("#ai-models option").evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))).toEqual(["claude-code", "gpt-a", "llama-3"]);

  mock.models = ["claude-opus-5-5", "claude-sonnet-5-5"];
  await page.locator('#ai-settings [name="format"]').selectOption("anthropic");
  await page.locator('#ai-settings [name="baseUrl"]').fill(baseUrl);
  await expect(page.locator("#ai-models option")).toHaveCount(2);
  expect(mock.modelRequests.at(-1)).toMatchObject({ path: "/v1/models", headers: { "x-api-key": KEY } });
});
