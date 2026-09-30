import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

// Workspace packages are bundled from source.
const alias = {
  "@svg-editor/model": resolve(__dirname, "../../packages/model/src/index.ts"),
  "@svg-editor/parser": resolve(__dirname, "../../packages/parser/src/index.ts"),
  "@svg-editor/sdk": resolve(__dirname, "../../packages/sdk/src/index.ts"),
  "@svg-editor/ai-tools": resolve(__dirname, "../../packages/ai-tools/src/index.ts"),
};

export default defineConfig({
  // CommonJS for main and preload: a sandboxed preload must be CJS.
  main: { resolve: { alias }, build: { outDir: "out/main", rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } } },
  preload: { build: { outDir: "out/preload", rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } } },
  renderer: {
    root: "src/renderer",
    resolve: { alias },
    build: { outDir: "out/renderer" },
  },
});
