# svg-builder-sdk

Desktop SVG editor (Electron + TypeScript) with a code pane, a visual canvas, and a scriptable SDK over one shared document model. See [`docs/svg-editor-plan.md`](docs/svg-editor-plan.md).

## Layout

```
packages/
  model/    pure-TS document model: nodes, commands, history, queries   (Phase 1, step 1)
  parser/   SVG <-> model with source ranges, minimal patches, ID reconcile (step 2)
  sdk/      public API: commands, queries, undo, selection, text          (step 6)
apps/
  desktop/  Electron app: code pane + live canvas                          (step 3)
```

## Download the app

Installers are built by GitHub Actions only, never locally. They are **unsigned** for now, so on first launch:
- **Windows:** SmartScreen warns; choose "More info" → "Run anyway".
- **macOS:** right-click the app → Open.
- **Linux:** mark the AppImage executable, then run it.

To get them: open the repository's **Actions** tab, pick the latest green **CI** run, and download from **Artifacts**:
- `SVG-Editor-Windows` (`.exe` installer)
- `SVG-Editor-macOS` (`.dmg`, Apple silicon and Intel)
- `SVG-Editor-Linux` (`.AppImage`)

Each installer is smoke-tested in CI (the packaged app is launched and checked) before it is uploaded.

## Building

CI in GitHub Actions is the build of record: every push runs install, typecheck, tests and build on Node 22 and 24, and uploads `packages/*/dist` as the `dist` artifact.

Locally (Node >= 22.12, pnpm via corepack):

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
pnpm --filter @svg-editor/desktop start      # run the app
pnpm --filter @svg-editor/desktop test:e2e   # end-to-end (needs a display; CI uses xvfb-run)
```
