# Project: SVG editor (Electron + TypeScript)

Plan: `docs/svg-editor-plan.md`. Decisions made along the way: `docs/decisions.md`.

## Rules
- `packages/model` and `packages/sdk` must stay pure TS: no DOM, no Electron, no framework imports.
- All document mutations go through commands. Never mutate model state directly from UI code.
- SDK returns IDs and plain data only, never DOM nodes.
- Code-pane edits must be minimal text patches; never reserialize the whole document on a canvas edit.
- Renderer has no Node access; use the preload bridge.
- Every new command needs: type, handler, undo, unit tests, and an SDK method.
- Errors are structured: { code, message, hint }.

## Workflow
- Work one Phase-1 step at a time; stop at each step's acceptance test and report.
- Prefer boring, standard solutions. Ask before adding a dependency.
- Run `pnpm test` before declaring a step done.
- GitHub Actions (`.github/workflows/ci.yml`) is the build of record: install, typecheck, test and build all run there. A step is done when CI is green on the pushed commit.
- Never commit build output (`dist/`); CI produces it as an artifact.

## Commits
- Author and commit as the repo owner only. No `Co-Authored-By`, `Claude-Session` or other AI attribution trailers in commit messages.
