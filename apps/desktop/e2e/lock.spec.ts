import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

let app: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  app = await electron.launch({ args: [fileURLToPath(new URL("../out/main/index.cjs", import.meta.url)), "--no-sandbox"] });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.waitForSelector("#canvas svg");
});

test.afterEach(async () => {
  // Closing the last window quits the app, which can exit before this call returns.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
  await app.close();
});

const code = () => page.evaluate(() => (window as unknown as { editor: { view: { state: { doc: { toString(): string } } } } }).editor.view.state.doc.toString());
const menu = (action: string) => app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0]!.webContents.send("menu", a), action);

/** Starts a lock session in the page, as an AI turn would, and keeps it on window.session. */
async function lock(label = "AI is editing…") {
  await page.evaluate((l) => {
    const w = window as unknown as { editor: { editor: { lock(o: object): unknown } }; session: unknown };
    w.session = w.editor.editor.lock({ reason: "ai", label: l });
  }, label);
}

/** Writes through the session (the lock holder). */
async function sessionAdd(tag: string, attrs: Record<string, string | number>) {
  await page.evaluate(
    ([t, a]) => (window as unknown as { session: { doc: { add(t: string, a: object): string } } }).session.doc.add(t as string, a as object),
    [tag, attrs] as const,
  );
}

test("locked: banner shown, canvas/panels/code/tools disabled, holder's edits show live", async () => {
  const original = await code();
  await page.locator("#tab-layers-button").click();
  await lock("AI is drawing a house");
  await expect(page.locator("#lock-banner")).toBeVisible();
  await expect(page.locator("#lock-label")).toHaveText("AI is drawing a house");
  await expect(page.locator('button[data-tool="rect"]')).toBeDisabled();

  // Canvas and panels ignore the user.
  await page.locator("#canvas svg > rect").click({ force: true });
  await expect(page.locator("#overlay .handle")).toHaveCount(0);
  await page.locator(".layer-row").first().click({ force: true });
  await expect(page.locator(".layer-row.selected")).toHaveCount(0);

  // Code pane is read-only.
  await page.locator("#code .cm-content").click({ force: true });
  await page.keyboard.type("garbage");
  expect(await code()).toBe(original);

  // Undo is refused with an explanation.
  await page.keyboard.press("Control+z");
  await expect(page.locator("#status")).toContainText("Stop it first");

  // The holder's edits appear on the canvas and in the code as they happen.
  await sessionAdd("circle", { cx: 20, cy: 20, r: 5, id: "ai1" });
  await expect(page.locator("#canvas svg circle#ai1")).toHaveCount(1);
  expect(await code()).toContain('id="ai1"');
});

test("Stop discards the whole turn and unlocks", async () => {
  const original = await code();
  await lock();
  await sessionAdd("circle", { r: 5, id: "ai1" });
  await sessionAdd("circle", { r: 6, id: "ai2" });
  await page.locator("#lock-stop").click();
  await expect(page.locator("#lock-banner")).toBeHidden();
  await expect.poll(code).toBe(original);
  await expect(page.locator("#status")).toContainText("discarded");
  // Editing works again.
  await page.locator("#canvas svg > rect").click();
  await expect(page.locator("#overlay .handle")).toHaveCount(9);
  await expect(page.locator('button[data-tool="rect"]')).toBeEnabled();
});

test("Stop & keep keeps the partial turn as one undo step", async () => {
  const original = await code();
  await lock();
  await sessionAdd("circle", { r: 5, id: "ai1" });
  await sessionAdd("circle", { r: 6, id: "ai2" });
  await page.locator("#lock-keep").click();
  await expect(page.locator("#lock-banner")).toBeHidden();
  await expect(page.locator("#canvas svg circle[id^=ai]")).toHaveCount(2);
  await page.locator("#canvas").focus();
  await page.keyboard.press("Control+z");
  await expect.poll(code).toBe(original);
});

test("simulated AI turn: runs under the lock, one Ctrl+Z removes it all", async () => {
  const original = await code();
  await menu("simulateAiTurn");
  await expect(page.locator("#lock-banner")).toBeVisible();
  await expect(page.locator("#canvas svg > circle")).toHaveCount(3, { timeout: 5000 }); // sample circle + 2 so far
  await expect(page.locator("#lock-banner")).toBeHidden({ timeout: 10_000 });
  await expect(page.locator("#canvas svg > circle")).toHaveCount(6);
  await expect(page.locator("#status")).toContainText("finished");
  await page.locator("#canvas").focus();
  await page.keyboard.press("Control+z");
  await expect.poll(code).toBe(original);
});

test("Stop during a simulated turn rolls it back immediately", async () => {
  const original = await code();
  await menu("simulateAiTurn");
  await expect(page.locator("#canvas svg > circle")).toHaveCount(2, { timeout: 5000 });
  await page.locator("#lock-stop").click();
  await expect(page.locator("#lock-banner")).toBeHidden();
  await expect.poll(code).toBe(original);
  // It stays stopped: no more shapes arrive later.
  await page.waitForTimeout(1500);
  expect(await code()).toBe(original);
});

test("file actions are refused while locked", async () => {
  await lock();
  await menu("new");
  await expect(page.locator("#status")).toContainText("Stop it first");
  await expect(page.locator("#canvas svg > rect")).toHaveCount(1);
  await page.locator("#lock-stop").click();
});
