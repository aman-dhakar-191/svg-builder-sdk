import { _electron as electron, expect, test } from "@playwright/test";

// Runs only when PACKAGED_APP points at a packaged executable (CI package job).
test.skip(!process.env.PACKAGED_APP, "set PACKAGED_APP to a packaged executable");

test("the packaged app starts, renders and has its preload bridge", async () => {
  const app = await electron.launch({ executablePath: process.env.PACKAGED_APP!, args: ["--no-sandbox"] });
  const page = await app.firstWindow();
  await expect(page.locator("#canvas svg rect")).toHaveCount(1);
  await expect(page.locator(".layer-row")).toHaveCount(3);
  expect(await page.evaluate(() => typeof (window as unknown as { desktop?: { openFile?: unknown } }).desktop?.openFile)).toBe("function");
  expect(await app.evaluate(({ app }) => app.getName())).toBe("Curvant");
  // Closing the last window quits the app, which can exit before this call returns.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
  await app.close();
});
