import { defineProject } from "vitest/config";

const src = (p: string) => new URL(`../${p}/src/index.ts`, import.meta.url).pathname;

export default defineProject({
  resolve: {
    alias: {
      "@svg-editor/model": src("model"),
      "@svg-editor/parser": src("parser"),
      "@svg-editor/sdk": src("sdk"),
    },
  },
  test: {
    name: "sdk",
    include: ["test/**/*.test.ts"],
  },
});
