# svg-builder-sdk

Desktop SVG editor (Electron + TypeScript) with a code pane, a visual canvas, and a scriptable SDK over one shared document model. See [`docs/svg-editor-plan.md`](docs/svg-editor-plan.md).

## Layout

```
packages/
  model/    pure-TS document model: nodes, commands, history, queries   (Phase 1, step 1)
  parser/   SVG <-> model with source ranges, minimal patches, ID reconcile (step 2)
  sdk/      public API: commands, queries, undo, selection, text          (step 6)
  ai-tools/ AI tool schemas, system prompt, dispatcher onto the SDK       (Phase 2)
apps/
  desktop/  Electron app: code pane + live canvas                          (step 3)
```

## AI side chat

The **AI** tab in the sidebar chats with a model that edits the drawing through the same SDK tools (add, set, delete, group, transform, align, …). Open **AI settings** to pick:
- **API format:** Anthropic (Claude) or OpenAI-compatible (OpenAI, OpenRouter, Ollama, LM Studio, vLLM, …)
- **Base URL:** empty for the provider's official endpoint
- **Model** (default `claude-opus-5-5`), **effort**, and **API key**

The key is encrypted with the OS keychain and never reaches the page; on Linux without a keyring it is kept in memory until the app quits. The editor is locked while the AI works, **Stop** discards the turn, and one Ctrl+Z undoes a finished turn. On the official Anthropic API with a supported model, server-side fallback is on: if the model declines a request, Anthropic retries it on another model.

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
