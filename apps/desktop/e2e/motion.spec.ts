import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let app: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  app = await electron.launch({ args: [fileURLToPath(new URL("../out/main/index.cjs", import.meta.url)), "--no-sandbox"], env: { ...process.env, SVG_EDITOR_USER_DATA: mkdtempSync(join(tmpdir(), "svg-editor-e2e-")) } });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1500, height: 850 });
  await page.waitForSelector("#canvas svg");
});

test.afterEach(async () => {
  // Closing the last window quits the app, which can exit before this call returns.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
  await app.close();
});

/** Runs `fn` in the page with the app's debug handle (source as a string: page CSP forbids eval, CDP does not). */
const debug = <T>(fn: string) => page.evaluate(`(() => { const e = window.editor; ${fn} })()`) as Promise<T>;
const code = () => debug<string>("return e.view.state.doc.toString();");
/** The sample's rect as drawn on the canvas, and its current (animated) opacity. */
const rectOpacity = () => page.evaluate(() => getComputedStyle(document.querySelector("#canvas svg rect")!).opacity);

async function selectRect(): Promise<string> {
  const id = await debug<string>('const id = e.editor.doc.query({ tag: "rect" })[0]; e.editor.select([id]); return id;');
  await expect(page.locator("[data-preset=fadeIn]")).toBeVisible();
  return id;
}

test("a preset from the Design panel: one undo step, a preview, scrubbing, and the canvas rests at the end", async () => {
  const id = await selectRect();
  await expect(page.locator("#play")).toHaveCount(0);
  await page.locator("#motion-duration").fill("0.8");
  await page.locator("[data-preset=fadeIn]").click();

  await expect.poll(code).toContain('<animate attributeName="opacity" values="0;1"');
  expect(await code()).toContain('dur="0.8s" fill="freeze" data-motion="fadeIn"');
  await expect(page.locator("[data-applied=fadeIn]")).toBeVisible();
  // The preview plays by itself, then the drawing rests at the end with the handles back.
  await expect(page.locator("#play")).toBeVisible();
  await expect(page.locator("#play-time")).toHaveText("0.80 s / 0.80 s");
  await expect.poll(() => debug<boolean>("return e.session.playing;")).toBe(false);
  await expect(page.locator("#overlay .sel-box, #overlay rect").first()).toBeAttached();
  expect(await rectOpacity()).toBe("1");

  // Scrub to the start: the rect is invisible there, and the handles hide during the preview.
  await page.locator("#timeline").fill("0");
  await expect.poll(rectOpacity).toBe("0");
  await expect(page.locator("#play-done")).toBeVisible();
  expect(await page.locator("#overlay > *").count()).toBe(0);
  await page.locator("#play-done").click();
  await expect.poll(rectOpacity).toBe("1");

  // Layers show a badge instead of the <animate> element.
  await page.locator("#tab-layers-button").click();
  await expect(page.locator(`.layer-row[data-id="${id}"] .motion-badge`)).toBeVisible();
  await expect(page.locator(".layer-row .layer-tag", { hasText: /^animate$/ })).toHaveCount(0);
  await page.locator("#tab-design-button").click();

  // One undo step removes it; the chip's × removes it too.
  await page.locator("#canvas").focus();
  await page.keyboard.press("Control+z");
  await expect.poll(code).not.toContain("<animate");
  await expect(page.locator("#play")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(code).toContain("data-motion");
  await page.locator("[data-applied=fadeIn] button").click();
  await expect.poll(code).not.toContain("<animate");
});

test("click-triggered motion does not play when the shape is clicked on the canvas; the preview plays it", async () => {
  await selectRect();
  await page.locator("#motion-trigger").selectOption("click");
  await page.locator("[data-preset=fadeIn]").click();
  await expect.poll(code).toContain('begin="click"');
  await expect.poll(() => debug<boolean>("return e.session.playing;")).toBe(false);
  // Clicking the shape selects it; it must not start fading in from 0.
  const box = (await page.locator("#canvas svg rect").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(100);
  expect(await rectOpacity()).toBe("1");
  // In the preview it starts at its delay (0).
  await page.locator("#timeline").fill("0");
  await expect.poll(rectOpacity).toBe("0");
});

test("several shapes animate one after another; Export offers a still SVG", async () => {
  const ids = await debug<string[]>('const ids = e.editor.doc.query().filter((i) => ["rect", "circle"].includes(e.editor.doc.getNode(i).tag)); e.editor.select(ids); return ids;');
  expect(ids).toHaveLength(2);
  await page.locator("#motion-stagger").fill("0.5");
  await page.locator("[data-preset=popIn]").click();
  await expect.poll(code).toContain('data-motion="popIn"');
  await expect(page.locator("#play-time")).toHaveText("1.00 s / 1.00 s");

  const out = join(mkdtempSync(join(tmpdir(), "svg-editor-e2e-")), "still.svg");
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, out);
  await page.getByRole("button", { name: "Export" }).click();
  await page.locator('[data-export="static"]').click();
  await expect.poll(() => {
    try {
      return readFileSync(out, "utf8");
    } catch {
      return "";
    }
  }).toMatch(/^<svg[^>]*>\n  <rect/);
  expect(readFileSync(out, "utf8")).not.toContain("animateTransform");
  expect(readFileSync(out, "utf8")).toContain("<rect");
});

test("Remove all motion, and drawOn explains what it needs", async () => {
  await selectRect();
  await page.locator("[data-preset=drawOn]").click();
  await expect(page.locator("#status")).toContainText("has none");
  await page.locator("[data-preset=spin]").click();
  await page.locator("[data-preset=pulse]").click();
  await expect(page.locator("[data-applied]")).toHaveCount(2);
  await page.locator("#motion-remove-all").click();
  await expect.poll(code).not.toContain("animateTransform");
  await expect(page.locator("[data-applied]")).toHaveCount(0);
});

test("the inspector measures the resting shape while a preview plays", async () => {
  await selectRect();
  await page.locator("#motion-duration").fill("3");
  await page.locator("[data-preset=popIn]").click();
  await expect.poll(() => debug<boolean>("return e.session.playing;")).toBe(true);
  // Pop in starts from scale 0; the fields still show the rect itself.
  const field = (name: string) => page.locator(".inspector").getByLabel(name, { exact: true }).first();
  await expect(field("X")).toHaveValue("10");
  await expect(field("W")).toHaveValue("80");
  await page.locator("#timeline").fill("0");
  await page.locator("[data-preset=fadeIn]").click();
  await expect(field("W")).toHaveValue("80");
});
