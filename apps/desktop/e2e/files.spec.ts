import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let app: ElectronApplication;
let page: Page;
let dir: string;

const corpus = (name: string) => fileURLToPath(new URL(`../../../packages/parser/test/corpus/${name}`, import.meta.url));

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "svg-editor-e2e-"));
  app = await electron.launch({ args: [fileURLToPath(new URL("../out/main/index.cjs", import.meta.url)), "--no-sandbox"] });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1500, height: 850 });
  await page.waitForSelector("#canvas svg");
});

test.afterEach(async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
  await app.close();
});

type Editor = {
  view: { state: { doc: { toString(): string } } };
  editor: { patchFallbacks: number; getSourceRange(id: string): { start: number; end: number } | undefined; doc: { query(q?: object): string[]; getNode(id: string): { tag: string; attrs: Record<string, string> } } };
  viewport: { zoom: number; gridStep(): number };
};
/** Runs `fn` in the page with the app's debug handle (source as a string: page CSP forbids eval, CDP does not). */
const editor = <T>(fn: (e: Editor) => T) => page.evaluate(`(${fn.toString()})(window.editor)`) as Promise<T>;
const code = () => page.evaluate(() => (window as unknown as { editor: Editor }).editor.view.state.doc.toString());
const title = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle());
const menu = (action: string) => app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0]!.webContents.send("menu", a), action);

async function stubOpen(path: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
  }, path);
}
async function stubSave(path: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, path);
}

async function open(path: string) {
  await stubOpen(path);
  await menu("open");
  // The code pane works with "\n"; CRLF files are converted back on save.
  await expect.poll(code).toBe(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

/** `sub` appears in `full` in order (not necessarily contiguous). */
function isSubsequence(sub: string[], full: string[]): boolean {
  let j = 0;
  for (const line of full) if (j < sub.length && line === sub[j]) j++;
  return j === sub.length;
}

for (const name of ["inkscape.svg", "figma.svg", "illustrator.svg", "handwritten.svg"]) {
  test(`open ${name}, edit on canvas, in code and in properties, save with formatting intact`, async () => {
    const path = join(dir, name);
    copyFileSync(corpus(name), path);
    const original = readFileSync(path, "utf8");
    await open(path);
    expect(await title()).toBe(`${name} — SVG Editor`);
    await expect(page.locator(".layer-row").first()).toBeVisible();
    // Long names in the panels must not make the window itself scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);

    // Visual edit: select the first shape in the layers panel, nudge it on the canvas.
    const target = await editor((e) => e.editor.doc.query().find((id) => ["rect", "path", "circle", "polygon", "ellipse"].includes(e.editor.doc.getNode(id).tag))!);
    const range = await editor((e) => {
      const id = e.editor.doc.query().find((i) => ["rect", "path", "circle", "polygon", "ellipse"].includes(e.editor.doc.getNode(i).tag))!;
      return e.editor.getSourceRange(id)!;
    });
    await page.locator(`.layer-row[data-id="${target}"]`).click();
    await page.locator("#canvas").focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(code).toContain("translate(1 0)");
    expect(await title()).toMatch(/^• /);

    // Properties edit on the same element.
    await page.locator(".prop-add input").first().fill("data-edited");
    await page.locator(".prop-add input").nth(1).fill("yes");
    await page.locator(".prop-add button").click();
    await expect.poll(code).toContain('data-edited="yes"');

    // Code edit: add an element just before </svg>.
    await page.evaluate(() => {
      const { view } = (window as unknown as { editor: { view: import("@codemirror/view").EditorView } }).editor;
      const at = view.state.doc.toString().lastIndexOf("</svg>");
      view.focus();
      view.dispatch({ selection: { anchor: at } });
    });
    await page.keyboard.type('<circle r="1" id="typed"/>');
    await expect(page.locator("#canvas svg circle#typed")).toHaveCount(1);

    await menu("save");
    await expect.poll(title).toBe(`${name} — SVG Editor`);
    const saved = readFileSync(path, "utf8");
    const crlf = original.includes("\r\n");
    expect(saved).toBe(crlf ? (await code()).replace(/\n/g, "\r\n") : await code());
    if (crlf) expect(saved.replace(/\r\n/g, "")).not.toContain("\n"); // every line still CRLF
    expect(saved).toContain('<circle r="1" id="typed"/>');
    expect(saved).toContain('data-edited="yes"');

    // Everything outside the edited element is byte-identical and in order.
    const norm = original.replace(/\r\n/g, "\n");
    const before = norm.slice(0, range.start).split("\n");
    const after = norm.slice(range.end).split("\n");
    const savedLines = saved.replace(/\r\n/g, "\n").split("\n");
    expect(isSubsequence(before.slice(0, -1), savedLines)).toBe(true);
    expect(isSubsequence(after.slice(1, -2), savedLines)).toBe(true);
    // Comments and declarations survive.
    for (const keep of original.match(/<!--[\s\S]*?-->|<\?xml[^>]*\?>|<!DOCTYPE[^[]*/g) ?? []) expect(saved).toContain(keep);
    expect(await editor((e) => e.editor.patchFallbacks)).toBe(0);
  });
}

test("layers panel: drag to reorder is one move command and one undo", async () => {
  const original = await code();
  const rows = page.locator(".layer-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator(".layer-tag")).toHaveText("rect");
  await rows.nth(0).dragTo(rows.nth(2), { targetPosition: { x: 20, y: 18 } });
  await expect(rows.nth(2).locator(".layer-tag")).toHaveText("rect");
  const now = await code();
  expect(now.indexOf("<rect")).toBeGreaterThan(now.indexOf("<text"));
  await page.locator("#canvas").focus();
  await page.keyboard.press("Control+z");
  await expect.poll(code).toBe(original);
});

test("properties panel edits and removes attributes as commands", async () => {
  const original = await code();
  await page.locator("#canvas svg > circle").click();
  const fill = page.locator('#props input[data-field="attr:fill"]');
  await fill.fill("#ff0000");
  await fill.press("Enter");
  await expect(page.locator("#canvas svg > circle")).toHaveAttribute("fill", "#ff0000");
  await page.locator('#props .prop-remove[title="Remove r"]').click();
  await expect.poll(code).not.toMatch(/<circle[^>]* r="30"/);
  await page.locator("#canvas").focus();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect.poll(code).toBe(original);
});

test("save as, then export PNG at the drawing's size", async () => {
  const svgPath = join(dir, "saved-as.svg");
  await stubSave(svgPath);
  await menu("saveAs");
  await expect.poll(title).toBe("saved-as.svg — SVG Editor");
  expect(readFileSync(svgPath, "utf8")).toBe(await code());

  const pngPath = join(dir, "export.png");
  await stubSave(pngPath);
  await menu("exportPng");
  await expect.poll(() => {
    try {
      return readFileSync(pngPath).length;
    } catch {
      return 0;
    }
  }).toBeGreaterThan(100);
  const png = readFileSync(pngPath);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(400); // width attribute of the sample
  expect(png.readUInt32BE(20)).toBe(240);
});

test("zoom, grid and snapping", async () => {
  const width = async () => (await page.locator("#canvas svg").boundingBox())!.width;
  await menu("zoom100");
  await expect.poll(width).toBeCloseTo(400, 0);
  await expect(page.locator("#zoom")).toHaveText("100%");
  await menu("zoomIn");
  await expect.poll(width).toBeCloseTo(600, 0);
  await page.locator('[data-view="fit"]').click();
  await expect(page.locator("#zoom")).not.toHaveText("150%");

  await menu("toggleGrid");
  await expect(page.locator("#grid path.grid-lines")).toHaveCount(1);
  await menu("toggleSnap");
  await expect(page.locator('[data-view="snap"]')).toHaveAttribute("aria-pressed", "true");

  const step = await editor((e) => e.viewport.gridStep());
  await page.locator('.toolbar [data-tool="rect"]').click();
  const box = (await page.locator("#canvas svg").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.53, box.y + box.height * 0.61);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.77, box.y + box.height * 0.87, { steps: 4 });
  await page.mouse.up();
  const attrs = await editor((e) => {
    const rects = e.editor.doc.query({ tag: "rect" });
    return e.editor.doc.getNode(rects[rects.length - 1]!).attrs;
  });
  for (const k of ["x", "y", "width", "height"]) {
    const v = Number(attrs[k]);
    expect(Math.abs(v / step - Math.round(v / step)), `${k}=${v} on a ${step} grid`).toBeLessThan(1e-6);
  }
});

test("a file that does not parse opens in the code pane with the error marked", async () => {
  const path = join(dir, "broken.svg");
  writeFileSync(path, '<svg xmlns="http://www.w3.org/2000/svg">\n  <rect width="10" height="10"\n</svg>\n');
  await stubOpen(path);
  await menu("open");
  await expect.poll(code).toContain('<rect width="10" height="10"\n');
  await expect(page.locator("#status")).toHaveClass(/error/);
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(1);
  // Fix it in the code pane: the canvas follows.
  await page.evaluate(() => {
    const { view } = (window as unknown as { editor: { view: import("@codemirror/view").EditorView } }).editor;
    const at = view.state.doc.toString().indexOf('height="10"') + 'height="10"'.length;
    view.focus();
    view.dispatch({ selection: { anchor: at } });
  });
  await page.keyboard.type("/>");
  await expect(page.locator("#canvas svg rect")).toHaveCount(1);
});

test("new document asks before discarding unsaved changes", async () => {
  await page.locator("#canvas svg > rect").click();
  await page.keyboard.press("Delete");
  page.once("dialog", (d) => void d.dismiss());
  await menu("new");
  await expect(page.locator("#canvas svg > circle")).toHaveCount(1); // kept
  page.once("dialog", (d) => void d.accept());
  await menu("new");
  await expect(page.locator("#canvas svg > *")).toHaveCount(0);
  expect(await title()).toBe("Untitled.svg — SVG Editor");
});
