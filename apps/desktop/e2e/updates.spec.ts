import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let app: ElectronApplication;
let page: Page;
let userData: string;
let server: Server | null = null;

async function launch(env: Record<string, string> = {}): Promise<void> {
  userData = mkdtempSync(join(tmpdir(), "svg-editor-e2e-"));
  app = await electron.launch({
    args: [fileURLToPath(new URL("../out/main/index.cjs", import.meta.url)), "--no-sandbox"],
    env: { ...process.env, SVG_EDITOR_USER_DATA: userData, ...env },
  });
  page = await app.firstWindow();
  await page.waitForSelector("#canvas svg");
}

/** A local update feed: the latest-linux.yml GitHub Releases would serve, for version `version` (read per request). */
async function feed(version: () => string): Promise<string> {
  const yml = () => `version: ${version()}\nfiles:\n  - url: Curvant-${version()}-linux-x86_64.AppImage\n    sha512: ${"A".repeat(86)}==\n    size: 1000\npath: Curvant-${version()}-linux-x86_64.AppImage\nsha512: ${"A".repeat(86)}==\nreleaseDate: '2026-10-01T00:00:00.000Z'\n`;
  server = createServer((req, res) => {
    if (req.url?.startsWith("/latest-linux.yml")) {
      res.writeHead(200, { "content-type": "text/yaml" });
      res.end(yml());
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

test.afterEach(async () => {
  // Closing the last window quits the app, which can exit before this call returns.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
  await app.close();
  server?.close();
  server = null;
  rmSync(userData, { recursive: true, force: true });
});

const openUpdates = async () => {
  await page.locator("#open-settings").click();
  await page.getByRole("button", { name: "Updates" }).click();
  await expect(page.locator("#updates")).toBeVisible();
};

test("a development build says updates need the installed app; the automatic check can be turned off", async () => {
  await launch();
  await openUpdates();
  await expect(page.locator("#updates")).toContainText(/You have Curvant \d+\.\d+\.\d+/);
  await page.locator("#check-updates").click();
  await expect(page.locator("#update-status")).toHaveText("Updates only work in the installed app.");

  const auto = page.getByRole("checkbox", { name: /Check for updates when the app starts/ });
  await expect(auto).toBeChecked();
  await auto.uncheck();
  expect(await page.evaluate(() => (window as unknown as { desktop: { update: { get(): Promise<{ autoCheck: boolean }> } } }).desktop.update.get())).toMatchObject({ autoCheck: false });
});

test("a newer version on the feed is found: Settings, the status bar and the palette's check", async () => {
  await launch({ SVG_EDITOR_UPDATE_URL: await feed(() => "99.0.0") });
  await openUpdates();
  await page.locator("#check-updates").click();
  await expect(page.locator("#update-status")).toHaveText("Version 99.0.0 is available.");
  await page.keyboard.press("Escape");
  await expect(page.locator("#status")).toHaveText("Version 99.0.0 is available.");
});

test("the same version on the feed: this is the latest", async () => {
  // An unpackaged run reports Electron's version; the feed answers with whatever the app reports.
  let current = "0.0.0";
  await launch({ SVG_EDITOR_UPDATE_URL: await feed(() => current) });
  current = await app.evaluate(({ app: a }) => a.getVersion());
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search actions").fill("check for updates");
  await page.keyboard.press("Enter");
  await expect(page.locator("#status")).toHaveText(`Curvant ${current} is the latest version.`);
});
