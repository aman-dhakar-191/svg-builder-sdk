import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Downloads the Electron binary once, before workers launch it in parallel.
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
});
