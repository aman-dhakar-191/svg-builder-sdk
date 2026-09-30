import { defineProject } from "vitest/config";

// Unit tests for renderer logic that needs no DOM. The app itself is tested
// end-to-end with Playwright (e2e/).
export default defineProject({
  test: {
    name: "desktop",
    include: ["src/**/*.test.ts"],
  },
});
