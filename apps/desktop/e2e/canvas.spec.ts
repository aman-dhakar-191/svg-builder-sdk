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
  // destroy() skips the "save changes?" prompt of edited documents.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
  await app.close();
});

type Win = { editor: { view: { state: { doc: { toString(): string } } }; editor: { patchFallbacks: number; canUndo(): boolean } } };
const code = () => page.evaluate(() => (window as unknown as Win).editor.view.state.doc.toString());
const fallbacks = () => page.evaluate(() => (window as unknown as Win).editor.editor.patchFallbacks);
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
    await page.locator(`button[data-tool="${tool}"]`).click();
    const box = (await page.locator("#canvas svg").boundingBox())!;
    await drag({ x: box.x + box.width * 0.55, y: box.y + box.height * 0.6 }, { x: box.x + box.width * 0.8, y: box.y + box.height * 0.9 });
    await expect(page.locator(`#canvas svg > ${tag}`)).toHaveCount(tag === "rect" ? 2 : 1);
    await expect(page.locator("button[data-tool=select]")).toHaveAttribute("aria-pressed", "true");
    expect(await code()).toContain(`<${tag} `);
    await undoRestores(original);
  });
}

test("text tool adds a text element with its content in one undo step", async () => {
  const original = await code();
  await page.locator('button[data-tool="text"]').click();
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
  expect(await page.evaluate(() => (window as unknown as Win).editor.editor.canUndo())).toBe(false);
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

test("shapes dragged past the page edge stay visible and grabbable; the page edge is marked", async () => {
  await page.locator('[data-view="zoomOut"]').click(); // leave room around the page
  await page.locator('[data-view="zoomOut"]').click();
  const page_ = page.locator("#canvas > svg");
  const pageBox = (await page_.boundingBox())!;
  const c = await center(circle());
  // Drag the circle so its center lands 40px beyond the page's right edge.
  const to = { x: pageBox.x + pageBox.width + 40, y: c.y };
  await drag(c, to);
  await expect(page.locator("#canvas svg > circle")).toHaveAttribute("transform", /translate/);

  // Not clipped: the circle is what's under the pointer outside the page, and it can be dragged back.
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.tagName, [to.x, to.y]);
  expect(hit).toBe("circle");
  const off = await page_.evaluate((svg) => getComputedStyle(svg).overflow);
  expect(off).toBe("visible");
  // Outside the page is dimmed (mask with a hole for the page), so it reads as "cropped on export".
  await expect(page.locator("#grid path.off-page")).toHaveCount(1);
  await page.screenshot({ path: "test-results/off-page.png" });

  await drag(to, c);
  const back = (await circle().boundingBox())!;
  expect(back.x + back.width).toBeLessThan(pageBox.x + pageBox.width);
});

// ----------------------------------------------------------- path editing

const menu = (action: string) => app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0]!.webContents.send("menu", a), action);
const nodes = () => page.locator("#overlay .handle.node");

test("Convert to Path, then drag a node: preview matches result, one undo step, minimal patch", async () => {
  const original = await code();
  await rect().click();
  await menu("convertToPath");
  const path = page.locator("#canvas svg > path");
  // The sample rect has rx="8": corners become arcs.
  const converted = "M18 10 H82 A8 8 0 0 1 90 18 V62 A8 8 0 0 1 82 70 H18 A8 8 0 0 1 10 62 V18 A8 8 0 0 1 18 10 Z";
  await expect(path).toHaveAttribute("d", converted);
  await expect(page.locator("#canvas svg > rect")).toHaveCount(0);
  await expect(nodes()).toHaveCount(9); // M + 4 lines + 4 arcs
  await expect(page.locator("#status")).toContainText("Editing path nodes");
  const afterConvert = await code();
  expect(afterConvert).toContain(`<path fill="#4f46e5" d="${converted}"/>`); // attributes keep their order

  // Drag the second node (end of the top edge) down-left.
  const b = (await nodes().nth(1).boundingBox())!;
  const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  let preview = "";
  await drag(from, { x: from.x - 40, y: from.y + 30 }, { beforeUp: async () => { preview = (await path.getAttribute("d"))!; } });
  await expect.poll(() => path.getAttribute("d")).toBe(preview);
  expect(preview).toMatch(/^M18 10 L\d+(\.\d+)? \d+(\.\d+)? A8 8 0 0 1 90 18 L90 62 /);
  expect(changedLines(afterConvert, await code())).toHaveLength(1); // only the path's line
  expect(await fallbacks()).toBe(0);

  await page.keyboard.press("Control+z");
  await expect.poll(code).toBe(afterConvert);
  await page.keyboard.press("Control+z");
  await expect.poll(code).toBe(original);
});

test("double-click a path to edit its curve handles; Alt moves a point alone; Esc and Delete behave", async () => {
  await page.evaluate(() => (window as unknown as { editor: { editor: { doc: { add(t: string, a: object): string } } } }).editor.editor.doc.add("path", { d: "M20 100 C40 80 60 80 80 100", stroke: "black", fill: "none", "stroke-width": "3" }));
  const path = page.locator("#canvas svg > path");
  await expect(path).toHaveCount(1);
  // A point on the stroke, a quarter along, away from the selection handles.
  const on = await path.evaluate((el) => {
    const p = el as SVGPathElement;
    const q = p.getPointAtLength(p.getTotalLength() * 0.25).matrixTransform(p.getScreenCTM()!);
    return { x: q.x, y: q.y };
  });
  await page.mouse.dblclick(on.x, on.y);
  await expect(nodes()).toHaveCount(2);
  await expect(page.locator("#overlay .handle.ctrl")).toHaveCount(2);

  // Drag control point c1 up: only c1 changes.
  const c = (await page.locator("#overlay .handle.ctrl").first().boundingBox())!;
  const from = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
  await drag(from, { x: from.x, y: from.y - 20 });
  await expect.poll(() => path.getAttribute("d")).toMatch(/^M20 100 C40 \d+(\.\d+)? 60 80 80 100$/);

  // Alt+drag the end node: its handle (60 80) stays.
  const n = (await nodes().nth(1).boundingBox())!;
  const nf = { x: n.x + n.width / 2, y: n.y + n.height / 2 };
  await page.keyboard.down("Alt");
  await drag(nf, { x: nf.x + 20, y: nf.y });
  await page.keyboard.up("Alt");
  await expect.poll(() => path.getAttribute("d")).toMatch(/ 60 80 \d+(\.\d+)? 100$/);
  expect(await path.getAttribute("d")).not.toMatch(/ 80 100$/);

  // Delete does not delete the path while editing nodes; Esc leaves node editing.
  await page.keyboard.press("Delete");
  await expect(path).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(nodes()).toHaveCount(0);
  await expect(page.locator("#overlay .handle.nw")).toHaveCount(1); // normal handles again
});

test("Convert to Path explains what it cannot do", async () => {
  await page.locator("#canvas svg > text").click();
  await menu("convertToPath");
  await expect(page.locator("#status")).toContainText("cannot be converted");
  await expect(page.locator("#canvas svg > text")).toHaveCount(1);
});

test("Path > Union and Subtract: one path, bottom shape's style, one undo step; Simplify reports points", async () => {
  const original = await code();
  await rect().click();
  await circle().click({ modifiers: ["Shift"] });
  await menu("union");
  const path = page.locator("#canvas svg > path");
  await expect(path).toHaveCount(1);
  await expect(page.locator("#canvas svg > rect, #canvas svg > circle")).toHaveCount(0);
  await expect(path).toHaveAttribute("fill", "#4f46e5"); // the rect is at the bottom
  await expect(page.locator("#status")).toContainText("Union of 2 shapes");
  expect(await fallbacks()).toBe(0);
  await page.locator("#canvas").focus();
  await page.keyboard.press("Control+z");
  await expect.poll(code).toBe(original);

  // Rect and circle overlap? They don't in the sample: subtract keeps the rect, intersect is empty.
  await rect().click();
  await circle().click({ modifiers: ["Shift"] });
  await menu("intersect");
  await expect(page.locator("#status")).toContainText("is empty");
  expect(await code()).toBe(original);

  await menu("subtract");
  await expect(page.locator("#canvas svg > path")).toHaveCount(1);
  await expect(page.locator("#canvas svg > circle")).toHaveCount(0);
  await menu("simplify");
  await expect(page.locator("#status")).toContainText(/Simplified: \d+ → \d+ points/);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect.poll(code).toBe(original);
});

test("Path > Union needs two shapes", async () => {
  await rect().click();
  await menu("union");
  await expect(page.locator("#status")).toContainText("Select two or more shapes");
});
