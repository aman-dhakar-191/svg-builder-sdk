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
- **Model** (default `claude-opus-5-5`): pick from the list the endpoint offers, or type any name
- **Model can see images:** lets the AI take snapshots of the drawing to check its own work (turn off for text-only models; Test connection tells you)
- **Effort** and **API key**

The key is encrypted with the OS keychain and never reaches the page; on Linux without a keyring it is kept in memory until the app quits. The editor is locked while the AI works, **Stop** discards the turn, and one Ctrl+Z undoes a finished turn. On the official Anthropic API with a supported model, server-side fallback is on: if the model declines a request, Anthropic retries it on another model.

## Download the app

Installers are built by GitHub Actions only, never locally. They are **unsigned** for now, so on first launch:
- **Windows:** SmartScreen warns; choose "More info" → "Run anyway".
- **macOS:** right-click the app → Open.
- **Linux:** mark the AppImage executable, then run it.

**Releases:** every merge to `main` publishes a GitHub Release (`v0.1.0`, `v0.1.1`, …) with the installers attached. Get the latest from the repository's **Releases** page:
- `SVG-Editor-<version>-win-x64.exe`
- `SVG-Editor-<version>-mac-arm64.dmg` (Apple silicon) and `…-mac-x64.dmg` (Intel)
- `SVG-Editor-<version>-linux-x86_64.AppImage`

**Test builds:** every other push builds the same installers as `<next>-dev.<run>` versions. Open the **Actions** tab, pick the CI run, and download them from **Artifacts** (each is the installer file itself, not a zip).

Each installer is smoke-tested in CI (the packaged app is launched and checked) before it is uploaded. The patch number goes up automatically; to start a new minor or major version, change `version` in `apps/desktop/package.json` (e.g. to `0.2.0`).

## Building

CI in GitHub Actions is the build of record: every push runs install, typecheck, tests and build on Node 22 and 24, and uploads `packages/*/dist` as the `dist` artifact.

Locally (Node >= 22.12, pnpm via corepack):

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
pnpm --filter @svg-editor/desktop start      # run the app
pnpm --filter @svg-editor/desktop test:e2e   # end-to-end (needs a display; CI uses xvfb-run)
```
