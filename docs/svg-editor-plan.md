# SVG Builder/Editor: Project Plan

Desktop app (Electron + TypeScript). Side-by-side code pane and visual canvas, one shared model, a scriptable SDK, and later an AI side chat that draws through that same SDK.

Certainty tags used below: **[Certain]**, **[Likely]**, **[Guessing]**. Treat [Guessing] items as things to verify with a spike before committing.

---

## 1. Decisions locked

| Area | Decision |
|---|---|
| Shell | Electron (consistent Chromium rendering across OSes) |
| Language | TypeScript everywhere |
| Views | Code pane + visual canvas, side by side |
| Rendering | Browser DOM renders the SVG; custom overlay layer for selection/handles |
| SDK | Command layer over the model; UI and AI both use it |
| AI | Phase 2. Editor is **locked** while the AI works; whole AI turn = one undo step |
| Libraries | Custom for interaction + model; libs for hard geometry math and parsing |

## 2. Core architecture

**One source of truth: the Document Model.** The code pane and canvas are views of it.

```
 Code pane (CodeMirror) <--patches--> Document Model <--commands--> Canvas + overlay
                                          ^
                                          |  same commands
                               SDK (scripts, tests, AI tools)
```

Rules:
1. **Every mutation is a serializable command**, e.g. `{ op: "add", type: "rect", props }`. Undo/redo, macros, AI tool calls, and tests all fall out of this. [Certain] (standard command pattern)
2. **The model owns history**, not the code editor. CodeMirror's undo must not be the source of truth.
3. **SDK never leaks DOM nodes.** It returns IDs and plain data only.
4. **Every node has a stable ID** (see section 5 for the ID problem).
5. **Batch = one undo step.**
6. **Model package is pure TS** with no DOM or Electron imports, so it runs in Node for tests and headless scripting.

## 3. Stack

| Concern | Choice | Notes |
|---|---|---|
| Shell | Electron | Main process = files, menus, later AI/API calls. Renderer = editor. Use `contextIsolation` + preload bridge; no Node in renderer. [Certain] (standard secure setup) |
| Build | Vite + electron-vite (or electron-forge) | [Likely] fine; pick one and move on |
| Code pane | CodeMirror 6 | [Likely] easier than Monaco for range-based patching and custom decorations |
| Canvas | SVG in the DOM + separate overlay SVG/HTML layer | `getBBox()` and hit-testing come free |
| Parsing | Position-aware parser (start with `htmlparser2` in XML mode) | [Guessing] verify it gives reliable source offsets for SVG; fallback is `parse5` or a small custom tokenizer |
| Path math (Phase 2) | `paper.js` and/or `svgpath` | Booleans, simplify, arc-to-bezier. Do not hand-roll bezier booleans. [Certain] notorious time sink |
| Tests | Vitest | Model + SDK tested headless |
| UI framework | Your choice (React/Solid/Svelte) | Keep it out of the model package |

## 4. Repo structure (monorepo)

```
svg-editor/
  packages/
    model/        # pure TS: document, nodes, commands, history, queries
    parser/       # SVG <-> model with source ranges; patch generation
    sdk/          # public API wrapping model (editor.doc.add(...), batch, query)
    ai-tools/     # (Phase 2) tool schemas + dispatcher mapped to SDK
  apps/
    desktop/
      src/main/       # Electron main: files, menus, (Phase 2) AI calls
      src/preload/    # contextBridge API
      src/renderer/   # UI: code pane, canvas, overlay, panels
  docs/
  CLAUDE.md          # project rules for Claude Code (see section 11)
```

## 5. Data model

```ts
type NodeId = string; // e.g. "n_12"

interface SvgNode {
  id: NodeId;
  tag: string;                       // "rect", "g", "path", ...
  attrs: Record<string, string>;     // raw attribute strings, order preserved
  children: NodeId[];
  parent: NodeId | null;
  range?: { start: number; end: number };   // source offsets in the code text
  attrRanges?: Record<string, { start: number; end: number }>;
}

interface DocumentState {
  root: NodeId;
  nodes: Map<NodeId, SvgNode>;
  version: number;
}
```

**The ID problem (decide in Phase 1, step 2).** Internal IDs (`n_12`) must survive re-parsing when the user edits code, but you should not pollute their SVG with extra attributes. Approach:
- Keep internal IDs in the model only.
- After each reparse, **reconcile** new parse vs old tree by structural path + tag + attribute similarity, and reuse IDs where matched.
- [Guessing] This will be imperfect on big code edits (paste/reorder). Accept that IDs may reset on large edits; selection is cleared in that case.
- Optional later: a setting to write `data-id` attrs for stable references.

## 6. Commands (initial set)

```ts
type Command =
  | { op: "add";       parent?: NodeId; index?: number; tag: string; attrs: Record<string,string> }
  | { op: "set";       id: NodeId; attrs: Record<string, string | null> }   // null = remove attr
  | { op: "delete";    ids: NodeId[] }
  | { op: "move";      id: NodeId; parent: NodeId; index: number }          // reparent/reorder
  | { op: "group";     ids: NodeId[] }
  | { op: "ungroup";   id: NodeId }
  | { op: "transform"; id: NodeId; translate?: [number, number]; scale?: [number, number]; rotate?: number; origin?: "center" | [number, number] }
  | { op: "setText";   id: NodeId; text: string }
  | { op: "batch";     commands: Command[] };
```

Each command returns `{ ok: true, result }` or `{ ok: false, error: { code, message, hint } }`. Errors must be specific (the AI self-corrects well from specific errors).

## 7. SDK surface

```ts
const editor = createEditor({ svg: initialText });

// Write
const id = editor.doc.add("rect", { x: 10, y: 10, width: 100, height: 60, fill: "#4f46e5" });
editor.doc.set(id, { rx: 8 });
editor.doc.transform(id, { rotate: 15, origin: "center" });
editor.doc.group([id, otherId]);
editor.batch(() => { /* multiple ops, single undo step */ });

// Read (AI needs these as much as write)
editor.doc.getTree();          // plain-data tree, no DOM refs
editor.doc.getNode(id);
editor.doc.getBBox(id);        // computed via renderer bridge or geometry lib
editor.doc.query({ tag: "circle", attr: { fill: "red" } });
editor.getSelection();

// History
editor.undo(); editor.redo();

// Serialization
editor.toSvg({ pretty: true });
```

**getBBox in headless mode:** [Likely] needs a DOM. Options: run a jsdom-like environment (limited SVG geometry support) or delegate to the renderer when available and fall back to computed geometry for primitives (rect/circle/ellipse/line) in Node. Decide during Phase 1, step 1.

## 8. Code pane ↔ model sync (the hardest part)

**Direction A: code → model → canvas**
- Debounce (about 150 ms) then parse. On parse error, keep last-good model, show an error marker in the code pane, do not blank the canvas.
- Reconcile IDs (section 5), then re-render canvas.

**Direction B: canvas → model → code**
- A command changes the model; the parser layer emits a **minimal text patch** (e.g. replace just the `x="10"` value range) instead of reserializing the whole document.
- Apply as a CodeMirror transaction so cursor, folds, and formatting survive.
- Whitespace/comments/attribute order must be preserved. [Certain] Full reserialization destroys these; this is the reason for the position-aware approach.

**Loop prevention:** tag each change with an origin (`"code"`, `"canvas"`, `"sdk"`, `"ai"`) and ignore echoes.

**Fallback for edge cases:** if a patch can't be computed safely (e.g. structural change like group/ungroup), regenerate only the affected subtree's text, not the whole document.

## 9. Editor lock (for Phase 2 AI)

- `editor.lock({ reason: "ai" })` sets a state that:
  - disables canvas interaction (overlay ignores pointer events)
  - sets the CodeMirror pane to read-only
  - blocks non-AI commands at the SDK level (enforce here, not just in the UI)
- Visible banner + **Stop** button. Stop aborts the model request, unlocks, and keeps or discards partial work (see below).
- AI turn is wrapped in one `batch` transaction. **On Stop or error, roll back the whole turn by default**; offer "keep partial" as an option. [Guessing] rollback-by-default is the safer UX; confirm in testing.
- Always unlock in a `finally` block. A stuck lock is a worse bug than a bad AI edit.

## 10. Phases

### Phase 1: Core editor + SDK (no AI)

**Step 1: Model + commands (headless)**
- Node/tree structures, ID generation, all commands from section 6.
- History (undo/redo) with batching.
- Read API: `getTree`, `getNode`, `query`.
- Serializer: model to SVG text (basic, for tests).
- *Acceptance:* Vitest suite covers every command, undo/redo round-trips, batch = single undo step. No UI needed.

**Step 2: Parser + patching**
- Position-aware parse into the model with source ranges.
- Patch generator for `set`, `add`, `delete`, `move`, `setText`.
- ID reconciliation on reparse.
- *Acceptance:* Round-trip test: parse, apply command, patch text; untouched regions are byte-identical (comments, whitespace, attribute order preserved). Include a corpus of real-world SVGs (Inkscape, Figma, Illustrator exports, hand-written).

**Step 3: App shell + code pane + live render**
- Electron main/preload/renderer skeleton, secure defaults.
- CodeMirror pane, live render of parsed SVG on the canvas, error markers on parse failure.
- *Acceptance:* typing in the code pane updates the canvas; broken SVG keeps last-good render.

**Step 4: Canvas interaction**
- Overlay layer: click-select, multi-select, selection box.
- Move, resize, rotate handles (via `transform` command).
- Two-way selection highlight (click canvas = highlight range in code; cursor in code = select node).
- Tools: rect, ellipse, line, text.
- *Acceptance:* every canvas action is a command; code pane updates via minimal patches; one Ctrl+Z reverses one gesture.

**Step 5: Panels + file I/O**
- Layers/tree panel (drag to reorder = `move` command), properties panel (attr editing = `set`).
- Open/save/save-as/export (SVG; PNG if easy).
- Zoom/pan, grid, basic snapping.
- *Acceptance:* can open a real SVG, edit it visually and in code, save it with formatting mostly intact.

**Step 6: SDK hardening (Phase 1 exit)**
- Public `sdk` package with docs and typed errors.
- Headless script example that builds an SVG from scratch.
- **Exit test:** everything doable in the UI is doable through the SDK. Any UI-only action found here is a bug in the design, fix before Phase 2.

### Phase 2: AI + advanced editing

**Step 1: Editor lock (section 9)**
- Implement and test lock/unlock/Stop independently of any AI.

**Step 2: AI side chat**
- Chat panel in the renderer; model calls in the **main process** over IPC so the API key stays out of the renderer. [Likely] safer default.
- **Configurable AI provider** (settings screen): API format (`anthropic` or `openai-compatible`), base URL/endpoint, API key, model name. A small adapter per format in the main process translates tool calls both ways, so the SDK tool layer stays provider-agnostic. API key stored with Electron `safeStorage` (OS keychain), never sent to the renderer; the renderer only sees "key set / not set". Include a "Test connection" button that makes one tiny tool-call request and reports a specific error (bad key, unknown model, endpoint unreachable, model does not support tools).
- Capability check per model: tool calling is required; image input is required only for the Step 3 vision loop (disable `render_snapshot` when the configured model has no image input).
- Tool schemas generated from the SDK (small, high-level toolset: `add`, `set`, `delete`, `group`, `move`, `transform`, `query`, `get_tree`, plus helpers like `align`/`distribute`).
- Tool dispatcher: validate input, call SDK, return structured result/error.
- Whole turn in one batch; lock while running.
- *Acceptance:* "draw a simple house with a red door" produces valid SVG, editor locked during the run, one Ctrl+Z removes it all.

**Step 3: Vision loop**
- `render_snapshot` tool returns a PNG of the canvas (or a region) so the model can verify its own work.
- Cap iterations per turn (e.g. max tool calls) to prevent loops.

**Step 4: Path editing**
- Node + bezier handle editing on the overlay.
- Path ops via `paper.js`/`svgpath` (booleans, simplify, convert shapes to path).
- Add commands: `pathEdit`, `boolean`, `simplify`.

**Step 5: Polish**
- Snapping/guides driven by the model.
- Drag-to-scrub numeric values in the code pane.
- Hover in code = highlight on canvas.
- Pretty-print/minify on export.
- Surface failed AI commands clearly in chat.

## 11. CLAUDE.md (drop this in the repo root for Claude Code)

```md
# Project: SVG editor (Electron + TypeScript)

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
```

## 12. Risks

1. **Round-trip fidelity** is the make-or-break piece. Spike the parser + patching first (start of Phase 1, step 2) before building UI on top. [Likely]
2. **ID reconciliation** after large code edits will be imperfect. [Guessing] Accept resets on big changes; test with paste and reorder cases.
3. **Undo across two editors:** model owns history; CodeMirror history disabled or bridged. Mixed undo stacks are a classic bug source.
4. **Headless `getBBox`:** needs a plan (section 7). Text bounding boxes especially depend on fonts and rendering. [Likely]
5. **Performance on large SVGs:** DOM as renderer gets heavy with thousands of nodes. [Likely] Test a large file early; virtualize the layers panel; avoid full reparse per keystroke.
6. **Lock coverage:** must cover the code pane and SDK, not only the canvas. Enforce at the SDK layer.
7. **Scope creep:** define the supported SVG subset up front (suggested v1: shapes, paths, groups, text, basic transforms, fills/strokes, gradients read-only). Filters, masks, clip paths, and animation are round-trip preserved but not editable in v1.
8. **Electron footprint:** large installer and memory use. [Certain] (bundled Chromium). Acceptable for this app.

## 13. Open decisions (answer before/during Phase 1)

- Package manager and monorepo tool (pnpm workspaces suggested).
- UI framework for the renderer.
- Supported SVG subset for v1 (see risk 7).
- Headless `getBBox` strategy (section 7).
- On AI Stop/error: roll back vs keep partial (default: roll back).
- ~~Which model/provider for the AI chat, and how the user supplies an API key.~~ Decided: user-configurable API format + endpoint + API key + model (Phase 2, Step 2).

## 14. Suggested first prompt for Claude Code

> Read `svg-editor-plan.md` and `CLAUDE.md`. Set up the pnpm monorepo per section 4 with Vitest. Then implement **Phase 1, Step 1** only: the `model` package with node structures, the command set from section 6, undo/redo with batching, and the read API. Write the Vitest suite from the step's acceptance criteria. Stop and report when tests pass. Do not start the parser or any UI yet.
