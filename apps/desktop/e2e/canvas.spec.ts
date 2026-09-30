import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
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
  await app.close();
});

type Win = { editor: { view: { state: { doc: { toString(): string } } }; source: { fallbacks: number; doc: { canUndo(): boolean } } } };
const code = () => page.evaluate(() => (window as unknown as Win).editor.view.state.doc.toString());
const fallbacks = () => page.evaluate(() => (window as unknown as Win).editor.source.fallbacks);
const rect = () => page.locator("#canvas svg > rect");
const circle = () => page.locator("#canvas svg > circle");

async function center(l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }, opts: { shift?: boolean; beforeUp?: () => Promise<void> } = {}) {
  if (opts.shift) await page.keyboard.down("Shift");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 5, from.y + ((to.y - from.y) * i) / 5);
  await opts.beforeUp?.();
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up("Shift");
}

/** Drags and checks the committed model renders exactly where the preview was (no jump on release). */
async function dragNoJump(l: Locator, from: { x: number; y: number }, to: { x: number; y: number }) {
  let preview: { x: number; y: number; width: number; height: number } | null = null;
  await drag(from, to, { beforeUp: async () => { preview = await l.boundingBox(); } });
  await expect.poll(async () => {
    const b = (await l.boundingBox())!;
    const p = preview!;
    return Math.max(Math.abs(b.x - p.x), Math.abs(b.y - p.y), Math.abs(b.width - p.width), Math.abs(b.height - p.height));
  }).toBeLessThan(1);
}

/** Lines that differ between two texts (same line count assumed unless noted). */
function changedLines(a: string, b: string): string[] {
  const la = a.split("\n");
  const lb = b.split("\n");
  return lb.filter((line, i) => la[i] !== line);
}

async function undoRestores(original: string) {
  await page.keyboard.press("Control+z");
  await expect.poll(code).toBe(original);
  expect(await fallbacks()).toBe(0);
}

test("click selects: handles on canvas, source highlighted in code", async () => {
  await rect().click();
  await expect(page.locator("#overlay .handle")).toHaveCount(9);
  await expect(page.locator("#status")).toContainText("<rect>");
  await expect(page.locator(".cm-selected-node").first()).toContainText("<rect");
  await page.mouse.click(5 + (await page.locator("#canvas").boundingBox())!.x, 5 + (await page.locator("#canvas").boundingBox())!.y);
  await expect(page.locator("#overlay .handle")).toHaveCount(0);
});

test("dragging moves with one command, a minimal patch, and one undo", async () => {
  const original = await code();
  const c = await center(rect());
  await dragNoJump(rect(), c, { x: c.x + 40, y: c.y + 20 });
  await expect(rect()).toHaveAttribute("transform", /^translate\(/);
  const after = await code();
  const changed = changedLines(original, after);
  expect(changed).toHaveLength(1);
  expect(changed[0]).toContain("<rect");
  expect(await fallbacks()).toBe(0);
  await undoRestores(original);
  await expect(rect()).not.toHaveAttribute("transform", /./);
});

test("resize handle scales along the element's axes; one undo", async () => {
  const original = await code();
  await rect().click();
  const se = await center(page.locator("#overlay .handle.se"));
  await dragNoJump(rect(), se, { x: se.x + 60, y: se.y + 30 });
  await expect(rect()).toHaveAttribute("transform", /scale\(/);
  expect(changedLines(original, await code())).toHaveLength(1);
  await undoRestores(original);
});

test("rotate handle rotates around the center; one undo", async () => {
  const original = await code();
  await circle().click();
  const h = await center(page.locator("#overlay .handle.rotate"));
  const c = await center(circle());
  await dragNoJump(circle(), h, { x: c.x + 100, y: c.y + 40 });
  await expect(circle()).toHaveAttribute("transform", /^rotate\(/);
  await undoRestores(original);
});

test("shift-click multi-select moves both in one undo step", async () => {
  const original = await code();
  await rect().click();
  await circle().click({ modifiers: ["Shift"] });
  await expect(page.locator("#status")).toContainText("2 elements selected");
  const c = await center(circle());
  await drag(c, { x: c.x, y: c.y + 30 });
  await expect(rect()).toHaveAttribute("transform", /translate/);
  await expect(circle()).toHaveAttribute("transform", /translate/);
  expect(changedLines(original, await code())).toHaveLength(2);
  await undoRestores(original);
});

test("marquee selects enclosed elements", async () => {
  const box = (await page.locator("#canvas svg").boundingBox())!;
  await drag({ x: box.x - 10, y: box.y - 10 }, { x: box.x + box.width + 10, y: box.y + box.height + 10 });
  await expect(page.locator("#status")).toContainText("3 elements selected");
});

test("cursor in code selects the node on the canvas", async () => {
  await page.evaluate(() => {
    const { view } = (window as unknown as { editor: { view: import("@codemirror/view").EditorView } }).editor;
    const at = view.state.doc.toString().indexOf("<circle") + 3;
    view.focus();
    view.dispatch({ selection: { anchor: at } });
  });
  await expect(page.locator("#status")).toContainText("<circle>");
  await expect(page.locator("#overlay .handle")).toHaveCount(9);
});

for (const [tool, tag] of [["rect", "rect"], ["ellipse", "ellipse"], ["line", "line"]] as const) {
  test(`${tool} tool draws a ${tag} with one command`, async () => {
    const original = await code();
    await page.locator(`.toolbar [data-tool="${tool}"]`).click();
    const box = (await page.locator("#canvas svg").boundingBox())!;
    await drag({ x: box.x + box.width * 0.55, y: box.y + box.height * 0.6 }, { x: box.x + box.width * 0.8, y: box.y + box.height * 0.9 });
    await expect(page.locator(`#canvas svg > ${tag}`)).toHaveCount(tag === "rect" ? 2 : 1);
    await expect(page.locator(".toolbar [data-tool=select]")).toHaveAttribute("aria-pressed", "true");
    expect(await code()).toContain(`<${tag} `);
    await undoRestores(original);
  });
}

test("text tool adds a text element with its content in one undo step", async () => {
  const original = await code();
  await page.locator('.toolbar [data-tool="text"]').click();
  const box = (await page.locator("#canvas svg").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.8);
  await page.locator(".text-input").fill("Typed on canvas");
  await page.keyboard.press("Enter");
  await expect(page.locator("#canvas svg > text")).toHaveCount(2);
  expect(await code()).toContain(">Typed on canvas</text>");
  await page.locator("#canvas").focus();
  await undoRestores(original);
});

test("keyboard: Delete removes, arrows nudge, each one undo step", async () => {
  const original = await code();
  await rect().click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(rect()).toHaveAttribute("transform", "translate(1 10)");
  await page.keyboard.press("Delete");
  await expect(rect()).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(rect()).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(rect()).toHaveAttribute("transform", "translate(1 0)");
  await undoRestores(original);
});

test("Escape cancels a drag without touching the model", async () => {
  const original = await code();
  const c = await center(rect());
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 50, c.y + 50, { steps: 5 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(rect()).not.toHaveAttribute("transform", /./);
  expect(await code()).toBe(original);
  expect(await page.evaluate(() => (window as unknown as Win).editor.source.doc.canUndo())).toBe(false);
});

test("resizing a rotated shape follows its own axes without jumping", async () => {
  const original = await code();
  await rect().click();
  const h = await center(page.locator("#overlay .handle.rotate"));
  const c = await center(rect());
  await drag(h, { x: c.x + 120, y: c.y - 60 });
  await expect(rect()).toHaveAttribute("transform", /^rotate\(/);
  const se = await center(page.locator("#overlay .handle.se"));
  await dragNoJump(rect(), se, { x: se.x + 30, y: se.y + 40 });
  await expect(rect()).toHaveAttribute("transform", /^rotate\([^)]*\) translate\([^)]*\) scale\(/);
  await page.keyboard.press("Control+z");
  await undoRestores(original);
});
