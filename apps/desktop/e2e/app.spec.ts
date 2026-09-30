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

test("Ctrl+E switches editor / agent; Ctrl+K runs any action by name", async () => {
  await expect(page.locator("#code")).toBeVisible();
  await page.locator("#canvas").focus();
  await page.keyboard.press("Control+e");
  await expect(page.locator("#chat-input")).toBeVisible();
  await expect(page.locator("#code")).toBeHidden();
  await expect(page.locator("#canvas svg")).toBeVisible(); // the same canvas stays on screen
  await page.locator('[data-mode-switch="editor"]').click();
  await expect(page.locator("#code")).toBeVisible();

  await page.keyboard.press("Control+k");
  await page.getByLabel("Search actions").fill("theme dark");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The theme is remembered across launches; put it back for the other tests.
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search actions").fill("theme system");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
});

test("reduced motion: dialogs and panels appear without animating", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#open-settings").click();
  await expect(page.locator("#ai-settings")).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("pointing at markup in the code pane or at a layer outlines that element on the canvas", async () => {
  const at = await page.evaluate(() => {
    const { view } = (window as unknown as { editor: { view: import("@codemirror/view").EditorView } }).editor;
    const c = view.coordsAtPos(view.state.doc.toString().indexOf("<circle") + 3)!;
    return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
  });
  await page.mouse.move(at.x, at.y);
  await expect(page.locator("#overlay .hover-outline")).toHaveCount(1);
  await expect(page.locator("#overlay .handle")).toHaveCount(0); // a hint, not a selection
  await page.mouse.move(5, 300);
  await expect(page.locator("#overlay .hover-outline")).toHaveCount(0);

  await page.locator("#tab-layers-button").click();
  await page.locator(".layer-row").first().hover();
  await expect(page.locator("#overlay .hover-outline")).toHaveCount(1);
  await page.locator(".layer-row").first().click(); // once selected, the selection outline takes over
  await expect(page.locator("#overlay .hover-outline")).toHaveCount(0);
});

test("Alt+drag on a number in the code pane scrubs it: the canvas follows, one undo step, Esc cancels", async () => {
  const original = await code();
  // Screen position of the "80" in width="80".
  const at = await page.evaluate(() => {
    const { view } = (window as unknown as { editor: { view: import("@codemirror/view").EditorView } }).editor;
    const c = view.coordsAtPos(view.state.doc.toString().indexOf('width="80"') + 8)!;
    return { x: c.left, y: (c.top + c.bottom) / 2 };
  });
  const rect = page.locator("#canvas svg rect");
  const scrub = async (dx: number, beforeUp: () => Promise<void>) => {
    await page.mouse.move(at.x, at.y);
    await page.keyboard.down("Alt");
    await page.mouse.down();
    for (let i = 1; i <= 4; i++) await page.mouse.move(at.x + (dx * i) / 4, at.y);
    await beforeUp();
  };

  // 20 px right = 10 steps of 1: the canvas shows it during the drag.
  await scrub(20, async () => {
    await expect(rect).toHaveAttribute("width", "90");
    await page.mouse.up();
    await page.keyboard.up("Alt");
  });
  await expect.poll(code).toBe(original.replace('width="80"', 'width="90"'));
  await page.keyboard.press("Control+z");
  await expect.poll(code).toBe(original); // the whole drag was one step

  // Esc during the drag puts everything back.
  await scrub(-10, async () => {
    await expect(rect).toHaveAttribute("width", "75");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.keyboard.up("Alt");
  });
  await expect.poll(code).toBe(original);
  await expect(rect).toHaveAttribute("width", "80");
});
