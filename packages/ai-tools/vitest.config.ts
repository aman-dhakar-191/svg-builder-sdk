import { defineProject } from "vitest/config";

const src = (p: string) => new URL(`../${p}/src/index.ts`, import.meta.url).pathname;

export default defineProject({
  resolve: {
    alias: {
      "@svg-editor/model": src("model"),
      "@svg-editor/parser": src("parser"),
      "@svg-editor/sdk": src("sdk"),
      "@svg-editor/ai-tools": src("ai-tools"),
    },
  },
  test: {
    name: "ai-tools",
    include: ["test/**/*.test.ts"],
  },
});
