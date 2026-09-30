import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

let app: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  // --no-sandbox: CI runners and containers lack the OS sandbox; the renderer's
  // own `sandbox: true` / contextIsolation settings are unaffected.
  app = await electron.launch({ args: [fileURLToPath(new URL("../out/main/index.cjs", import.meta.url)), "--no-sandbox"] });
  page = await app.firstWindow();
  await page.waitForSelector("#canvas svg");
});

test.afterEach(async () => {
  // destroy() skips the "save changes?" prompt of edited documents.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
  await app.close();
});

/** Selects the first occurrence of `text` in the code pane (then real keystrokes replace it). */
async function select(text: string): Promise<void> {
  await page.evaluate((needle) => {
    const { view } = (window as unknown as { editor: { view: import("@codemirror/view").EditorView } }).editor;
    const from = view.state.doc.toString().indexOf(needle);
    if (from < 0) throw new Error(`not in code pane: ${needle}`);
    view.dispatch({ selection: { anchor: from, head: from + needle.length } });
    view.focus();
  }, text);
}

const code = () => page.evaluate(() => (window as unknown as { editor: { view: { state: { doc: { toString(): string } } } } }).editor.view.state.doc.toString());

test("renders the document on the canvas", async () => {
  await expect(page.locator("#canvas svg rect")).toHaveAttribute("fill", "#4f46e5");
  await expect(page.locator("#canvas svg circle")).toHaveCount(1);
  await expect(page.locator("#canvas svg text")).toHaveText("Hello, SVG");
});

test("typing in the code pane updates the canvas", async () => {
  await select("#4f46e5");
  await page.keyboard.type("#ff0000");
  await expect(page.locator("#canvas svg rect")).toHaveAttribute("fill", "#ff0000");
  await select("Hello, SVG");
  await page.keyboard.type("Typed live");
  await expect(page.locator("#canvas svg text")).toHaveText("Typed live");
});

test("broken SVG keeps the last good render and marks the error", async () => {
  await select("#4f46e5");
  await page.keyboard.type("#00ff00");
  await expect(page.locator("#canvas svg rect")).toHaveAttribute("fill", "#00ff00");

  await select('<circle cx="140"');
  await page.keyboard.type('<circle <cx="140"');
  await expect(page.locator("#status")).toHaveClass(/error/);
  await expect(page.locator("#status")).toContainText("Line 4");
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(1);
  // Canvas still shows the last good state.
  await expect(page.locator("#canvas svg rect")).toHaveAttribute("fill", "#00ff00");
  await expect(page.locator("#canvas svg circle")).toHaveCount(1);

  // Fix it: the canvas follows again and the marker goes away.
  await select('<circle <cx="140"');
  await page.keyboard.type('<circle cx="100"');
  await expect(page.locator("#canvas svg circle")).toHaveAttribute("cx", "100");
  await expect(page.locator("#status")).not.toHaveClass(/error/);
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);
});

test("Ctrl+Z undoes through the model: code and canvas together", async () => {
  const original = await code();
  await select("#4f46e5");
  await page.keyboard.type("#123456");
  await expect(page.locator("#canvas svg rect")).toHaveAttribute("fill", "#123456");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#canvas svg rect")).toHaveAttribute("fill", "#4f46e5");
  expect(await code()).toBe(original);
  // A real keyboard reports "Z" (uppercase) while Shift is held.
  await page.keyboard.press("Control+Shift+Z");
  await expect(page.locator("#canvas svg rect")).toHaveAttribute("fill", "#123456");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  await expect(page.locator("#canvas svg rect")).toHaveAttribute("fill", "#123456");
});

test("scripts in user SVG never run", async () => {
  await select("<!-- Edit the code");
  await page.keyboard.type('<script>window.pwned = 1</script><image href="x" onerror="window.pwned = 2"/><!-- Edit the code');
  await expect(page.locator("#canvas svg image")).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  await expect(page.locator("#canvas svg script")).toHaveCount(0);
  expect(await page.locator("#canvas svg image").getAttribute("onerror")).toBeNull();
});

test("renderer has no Node access", async () => {
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe("undefined");
  expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe("undefined");
  expect(await page.evaluate(() => (window as unknown as { desktop: { platform: string } }).desktop.platform)).toBe("linux");
});

test("the main process bundle needs only Electron and Node built-ins (no document model, no paper.js)", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = fileURLToPath(new URL("../out/main/", import.meta.url));
  const required = new Set<string>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".cjs"))) {
    for (const m of readFileSync(`${dir}/${f}`, "utf8").matchAll(/require\("([^"]+)"\)/g)) required.add(m[1]!);
  }
  const bad = [...required].filter((r) => r !== "electron" && !r.startsWith("node:") && !r.startsWith("./"));
  expect(bad).toEqual([]);
});
