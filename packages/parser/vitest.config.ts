import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: { "@svg-editor/model": new URL("../model/src/index.ts", import.meta.url).pathname },
  },
  test: {
    name: "parser",
    include: ["test/**/*.test.ts"],
  },
});
