# Decisions log

## Phase 1, step 1: model package

| Topic | Decision | Why / revisit when |
|---|---|---|
| Text content | Character data is a child node with tag `#text` and a `text` field (not a `text` field on the element). | Mixed content such as `<text>a<tspan>b</tspan>c</text>` needs it, and the parser (step 2) needs it for round-trips. `setText` on an element with element children fails with `HAS_ELEMENT_CHILDREN` instead of silently deleting them. |
| Undo mechanism | Commands compile to low-level reversible mutations (`insert`, `remove`, `attrs`, `text`, `move`); history stores forward + inverse pairs. | Redo replays the stored mutations, so it restores the **same node IDs**, which selection and AI references depend on. |
| Batching | `batch` command is atomic (any failure rolls back everything and returns `BATCH_FAILED` with a `path` to the failing sub-command). `beginTransaction()` / `transaction(fn)` group arbitrary commands into one undo step, nest, and can span `await` (for the Phase 2 AI turn). | Plan section 9: whole AI turn = one step, rollback by default. |
| Failed / no-op commands | Leave no history entry and do not clear redo. | A typo'd AI command should not wipe the user's redo stack. |
| `move.index` | The node's **final** index among the new parent's children. | Unambiguous for same-parent reorders. |
| `transform` | Prepends ops to the existing `transform` attribute (parent space). Consecutive pure translates are folded into a leading `translate(...)`. Default `origin` is `[0, 0]` (SVG semantics); `"center"` uses the headless bbox mapped through the existing transform. | Default origin is a guess; if the UI/AI mostly wants center, flip the default. |
| Headless `getBBox` | Computed from attributes for rect, circle, ellipse, line, polyline, polygon, image, foreignObject, and `g` (union through child transforms, corner hull, so rotated circles are over-estimated). Paths and text return `BBOX_UNAVAILABLE`. Percent/unit lengths other than `px` return `BBOX_UNAVAILABLE`. | Paths need `svgpath`/`paper.js` (needs approval as a dependency); text needs a renderer. |
| `ungroup` | Group `transform` is prepended to each child's transform; inherited presentation attributes are copied to children that don't set them; the group's `id` is dropped. Any other group attribute (`opacity`, `filter`, `clip-path`, `mask`, `style`, `class`, ...) fails with `UNGROUP_LOSSY`. | Those change rendering when moved onto children. |
| `query` | Whole document (root included) by default; with `within`, descendants only. Text nodes are returned only when `tag: "#text"` is requested. | |
| Change notifications | Added in step 2: `onMutation` (every low-level change) and `onHistory` (commit / undo / redo / discard). `version` increments on every change. | Designed with their consumer, the parser's patcher. |

## Phase 1, step 2: parser + patching

| Topic | Decision | Why / revisit when |
|---|---|---|
| Parser | Hand-written XML tokenizer (`packages/parser/src/parse.ts`), no dependency. | Spike: `htmlparser2` gives element and whole-attribute offsets but not attribute *value* offsets, and splits text at every entity; we would re-scan anyway. The tokenizer gives exact ranges for tags, attribute names/values/quotes, text runs, and handles DOCTYPE internal entities (Illustrator), CDATA, CRLF and BOM. Errors carry code, message, hint, line and column. |
| Source offsets | Live in the parser's source map, not on model nodes (the plan put `range` on `SvgNode`). | Undo would restore stale offsets from history snapshots. |
| Formatting whitespace | Whitespace-only text between elements is not in the model, except inside text containers (`text`, `tspan`, `textPath`, `title`, `desc`, `style`, `script`), where whitespace is content. | Keeps indices and queries meaningful; the source keeps the whitespace. |
| Patching | Every model mutation becomes a minimal text edit, applied, then the text is re-parsed and checked against the model ("zip"). A mismatch falls back to regenerating the smallest enclosing element, then the whole document; `fallbacks` counts these and tests require 0. | The re-parse is O(document) per mutation. Fine for normal files; revisit (incremental offset shifting) if large files feel slow in step 3. |
| Undo fidelity | The source document records the text at every history boundary and snaps to it after undo / redo / rollback. | Byte-exact undo even when comments or unusual whitespace were involved. Valid because the model owns all history. |
| Text normalization (model) | No adjacent or empty text nodes, ever, at every mutation (text is merged *before* a node between two text runs is removed). | Adjacent text nodes cannot be written as text; the patcher checks every intermediate state. |
| Pretty printing (model) | Never indents inside text containers. | Indenting inside `<text>` changes rendering. Was a real bug in step 1's serializer. |
| Moves across text containers | A node moved into or out of a text container is re-serialized for its new context instead of copying bytes. | Its internal whitespace changes meaning. |
| ID reconciliation | `reconcile(doc, parse)`: root, then unique `id` attributes anywhere, then per-parent alignment (same tag, attribute/text similarity), then identical subtrees anywhere (cut/paste). Unmatched nodes get new IDs. | Wiring code edits into the model as one undoable step is step 3. |
| Corpus | `packages/parser/test/corpus/` holds hand-written files that reproduce each exporter's quirks (Inkscape namespaces and multi-line attributes, Figma clip paths, Illustrator DOCTYPE entities with CRLF and tabs, odd hand-written formatting). They are **not** real exports. | Drop real exports into that folder; every `.svg` there is picked up by the round-trip and random-edit tests automatically. |
| Dependency | `@types/node` (dev only) so tests can read the corpus from disk. Parser `src` is typechecked without Node types. | |

## Phase 1, step 3: app shell, code pane, live render

| Topic | Decision | Why / revisit when |
|---|---|---|
| Build | electron-vite 5 (Vite 7; electron-vite does not support Vite 8 yet). Main and preload are bundled as CommonJS (`.cjs`). | A sandboxed preload must be CommonJS. |
| Security | `contextIsolation`, `sandbox`, no `nodeIntegration`; navigation and new windows blocked; CSP with `script-src 'self'`; preload exposes only `window.desktop` (platform for now). | Plan section 3. Tested end-to-end (no `require`/`process` in the renderer). |
| Rendering | Canvas DOM is built from the model tree, not from raw text. `<script>`, `on*` attributes and `javascript:` links are dropped; elements in foreign namespaces (editor metadata) are skipped. A `WeakMap` maps DOM elements to node IDs for step 4, without adding attributes to the drawing. | Re-renders the whole tree on each change; fine for now, revisit with large files. |
| Code -> model | Typing is debounced 150 ms, then `SourceDocument.setText`: parse, reconcile IDs, one `replace` command (one undo step). Parse errors keep the last good model and render and show a gutter marker plus "line, column: message" in the status bar. | |
| Undo | CodeMirror has no history; Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y go to the model (pending typing is flushed first). | Plan rule: the model owns history. |
| UI framework | None yet (plain TypeScript). | Still an open decision in the plan; decide before step 4/5 adds panels. |
| E2E tests | Playwright drives the built Electron app under Xvfb in CI. | New dev dependencies: `@playwright/test`, `electron`, `electron-vite`, `vite`, CodeMirror 6 packages. |

## Phase 1, step 4: canvas interaction

| Topic | Decision | Why / revisit when |
|---|---|---|
| Gestures | While dragging, only the DOM is previewed (the element's `transform` attribute, using the same math as the command). On release, one command (a `batch` for several elements) goes to the model. Escape cancels without touching the model. | One gesture = one undo step and one minimal code patch. The code pane updates on release, not during the drag; live code updates would re-parse on every mouse move. |
| Transform space | `transform` gained `space: "local"`: ops are appended, so they act along the element's own axes. Single-element resize uses it; move, rotate and multi-element resize use parent space. | Resizing a rotated shape in parent space would skew it. E2E tests check the committed result renders exactly where the preview was. |
| Resize | Via `scale` transforms, as the plan says. Strokes scale too. | If you want strokes to keep their width, resize rect/ellipse/line by editing their geometry attributes instead; that is a small change in `canvas.ts`. |
| Selection | Click selects the topmost element below the root or an Inkscape layer (`inkscape:groupmode="layer"`); Ctrl/Cmd+click selects the deepest. Shift+click toggles. Marquee selects fully enclosed elements. | |
| Two-way highlight | Canvas selection marks the nodes' source in the code pane (a decoration, the cursor does not move). Moving the code cursor selects the deepest element at that position (`SourceDocument.nodeAt`). | |
| Tools | Select (V), Rect (R), Ellipse (E), Line (L), Text (T). Shift constrains (square, circle, 45 degree lines, axis-locked moves, 15 degree rotation steps, proportional resize). New shapes go to the end of the root. Text: click, type, Enter; add + setText in one transaction. | Drawing into the selected group or current layer is a later refinement. |
| Keyboard | Delete/Backspace deletes; arrows nudge 1 (Shift: 10) user units; Escape cancels or deselects; Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y work from the canvas too. | |
| Rendering | Still a full re-render after each change. | Revisit with large files (step 5 zoom/pan is a good time). |

## Phase 1, step 5: panels and file I/O

| Topic | Decision | Why / revisit when |
|---|---|---|
| File access | The main process owns the file path per window, set only by the Open / Save As dialogs. The renderer sends text, never paths. | A compromised renderer cannot write arbitrary files. |
| Line endings | Files are normalized to "\n" on open and converted back to the file's own line ending on save. | CodeMirror always works with "\n"; without this a CRLF file (Illustrator on Windows) would be rewritten with LF on every line. Found by the corpus e2e test. Mixed line endings in one file are normalized to the first style found. |
| Unsaved changes | Dirty = code pane text differs from the last opened/saved text. Title shows "•"; closing asks Save / Don't Save / Cancel; New and Open ask before discarding. | |
| Broken files | A file that does not parse opens in the code pane with the error marked; the canvas shows an empty drawing until it is fixed. | |
| Layers panel | Document order, top to bottom (same as the code). Click selects, Shift toggles. Drag onto a row: upper/lower part = before/after, middle of a container = inside; one `move` command. Inkscape layers show their label. | Illustrator and Inkscape list the topmost object first (reverse order); flip if you prefer that. |
| Properties panel | Single selection: every attribute editable (Enter / leaving the field = one `set`), × removes, an add row, and a text field for text-only elements (`setText`). Multi-selection shows a count only. | Editing common attributes across a multi-selection is a later refinement. |
| Zoom / pan | The drawing is sized with CSS (intrinsic size x zoom); Ctrl+wheel zooms around the pointer, wheel scrolls, Space+drag or middle-drag pans. Fit on open. Menu: Ctrl+= / Ctrl+- / Ctrl+1 / Ctrl+0. | |
| Grid and snapping | Grid spacing is a 1/2/5 x 10^n number of user units, at least 12 screen px, so it adapts to zoom and to tiny icons vs large pages. Snapping (when on) puts drawn shapes' corners and a moved selection's top-left corner on the grid. Resize and rotate do not snap (rotate has Shift for 15 degree steps). | "Basic snapping" per the plan; snapping to other objects' edges is a later step. |
| PNG export | The model is rendered through an `<img>` into a canvas at the drawing's intrinsic size (1x). | External images referenced by URL are not included (CSP blocks remote loads). A scale option is easy to add. |
| Shared types | The preload bridge's types live in `src/shared/api.ts`, used by preload and renderer. | The renderer must not import Electron. |

## Phase 1, step 6: SDK hardening (Phase 1 exit)

| Topic | Decision | Why / revisit when |
|---|---|---|
| Package | `@svg-editor/sdk`: `createEditor()` returns an `Editor` with `doc` (commands and queries), undo/redo, `batch` / `beginBatch`, selection, source text and bridges. Documented in `packages/sdk/README.md`. | Plan section 7. |
| Errors | Write methods throw `SvgEditorError` (`code`, `message`, `hint`, `path` for batches, `parse` with line/column). `editor.execute(command)` is the non-throwing form for the Phase 2 tool dispatcher. `toJSON()` gives plain data for tool results. | |
| Attribute values | Numbers accepted and written with at most 6 decimals; non-finite numbers are `INVALID_ATTR`. | Plan example `add("rect", { x: 10 })`. |
| Selection | Moved from the canvas into the SDK (`select`, `getSelection`, `selectInRect`, `onSelectionChange`); nodes that disappear drop out automatically. | Was UI-only: found by the exit review. The AI needs `getSelection()`. |
| Renderer bridges | `rasterize` (PNG export) and `measure` (bounding boxes of paths and text) are injected; the desktop app provides DOM implementations. | Keeps the SDK pure TS. Headless PNG export would need a rasterizer library (e.g. resvg), which needs your approval. |
| Exit test | The app uses only the SDK for documents; `ui-parity.test.ts` checks the renderer's imports, runs an SDK equivalent for every UI action, and fails if a menu action or tool is added without an SDK mapping or a view-only mark. | View-only: zoom, pan, grid, snapping, tool choice. |
| Headless example | `examples/bar-chart.ts` builds a chart from data; CI runs it under plain Node against the built packages. | |

## Build and distribution

| Topic | Decision | Why / revisit when |
|---|---|---|
| Installers | Built only in GitHub Actions (`package` job, one runner per OS) with electron-builder: NSIS `.exe`, `.dmg` for arm64 and x64, `.AppImage`. Each packaged app is launched in a smoke test before its installer is uploaded as a workflow artifact. | Your rule: builds and executables come from Actions, not local machines. |
| Signing | Unsigned. Windows SmartScreen and macOS Gatekeeper warn on first launch. | Add certificates as repository secrets when you want signed builds; a tagged-release workflow can then publish installers to GitHub Releases. |
| Releases | Every push to `main` is a release: `.github/scripts/version.mjs` takes MAJOR.MINOR from `apps/desktop/package.json` and bumps PATCH past the highest `vMAJOR.MINOR.*` tag. The installers are attached to a draft release, which is published (creating the tag) only when all three OS builds passed. Re-running a released commit reuses its tag. Other builds are `<next>-dev.<run>`. | The tag is the source of truth, so CI never commits back to `main`. |
| Artifacts | Installers are uploaded unzipped (`archive: false`, one file per upload). The `dist` build-output artifact stays zipped because it is many files. | |
| Packaged contents | Only `out/` (bundled by electron-vite) and `package.json`; no `node_modules`. | Main and preload need only Electron and Node built-ins; the renderer is fully bundled. |

## Phase 2, step 1: editor lock

| Topic | Decision | Why / revisit when |
|---|---|---|
| Enforcement | In the SDK. `editor.lock()` hands out a session with its own `doc`; every other write path (commands, `setText`, undo/redo, `batch`) throws `LOCKED`, and `execute()` returns it as an error. Reads and selection stay open. | Plan section 9: enforce in the SDK, not just the UI. |
| One turn = one undo step | The session is one outer transaction. Nothing changed means no history entry. | |
| Stop | Rolls back by default; "Stop & keep changes" commits the partial turn. Stop aborts the session's `AbortSignal` (for cancelling the model request) and unlocks immediately, without waiting for the holder. | Plan: rollback by default, keep partial as an option. |
| No stuck locks | `runLocked` always ends the session (finally); a finished session cannot write again (`LOCK_RELEASED`); optional `timeoutMs` stops automatically; the UI can always stop (`stopLock`). | "A stuck lock is a worse bug than a bad AI edit." |
| UI while locked | Banner with Stop / Stop & keep; canvas and panels `inert`; code pane read-only but updating live; drawing tools, undo/redo, New/Open/Save refused with a message. Zoom and scrolling of the code still work. | |
| Testing without AI | Debug > Simulate AI Turn makes timed edits under `runLocked`; e2e tests cover lock, Stop, Stop & keep, and single-step undo. | Plan: implement and test lock/unlock/Stop independently of any AI. |

## Phase 2, step 2: AI side chat

| Topic | Decision | Why / revisit when |
|---|---|---|
| Split | Main process: key, conversation, provider calls. Renderer: runs each tool call through `@svg-editor/ai-tools` → SDK inside the turn's lock session. Tool calls cross IPC (`ai:toolCall` / `ai:toolResult`, 30 s timeout). | Key never in the renderer (plan); the renderer owns the editor, so tools stay SDK calls. `ui-parity.test.ts` checks `main/ai` imports only tool definitions, never the dispatcher. |
| Tools | 14 hand-written, high-level tools in `packages/ai-tools` (get_document, query, get_element, add_elements with `$N` parents, set_attributes, delete, move, group, ungroup, transform, set_text, align, distribute, select). Every input is validated against its JSON Schema before the SDK runs; every failure returns `{ code, message, hint }`. | Plan said "generated from the SDK"; the SDK has no runtime schemas, so they are written once and a test checks each has a handler. `add_elements` is all-or-nothing. |
| Providers | `anthropic`: official `@anthropic-ai/sdk`, streaming (`beta.messages.stream` + `finalMessage`). `openai-compatible`: plain `fetch` to `{base}/chat/completions`, non-streaming, key optional (local servers). | New dependency: `@anthropic-ai/sdk` (desktop devDependency, bundled into main). Revisit if we want streaming for OpenAI-compatible servers. |
| Anthropic request | Model default `claude-opus-5-5`; no `thinking` param (model default); `effort` sent only when set; `tool_choice` auto; tool loop capped at 30 rounds; refusal / `max_tokens` / `pause_turn` handled before running tools. On the official endpoint only: `eager_input_streaming` on tools (inputs are validated anyway) and `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) for claude-opus-5-5, opus-5, fable-5-1, sonnet-5-5. The settings panel says when fallback is on. | Proxies and gateways may reject beta-only fields, so a custom base URL gets none. |
| Turn outcome | Only a finished turn is kept: Stop, error, refusal and the round limit roll back the drawing, and the main process truncates the conversation to before the turn so the model does not remember discarded edits. "Stop & keep changes" keeps the drawing but still drops the turn from the conversation (the model can re-read the drawing). | Plan: whole turn = one undo step, Stop rolls back. |
| Stop | The lock session's `AbortSignal` sends `ai:stop`; the main process aborts the HTTP request and answers pending tool calls with `STOPPED`. | e2e checks the mock server sees the connection closed. |
| Key storage | `safeStorage` (keychain / DPAPI / libsecret), base64 in `userData/ai-settings.json` (mode 0600). Linux `basic_text` counts as insecure: key kept in memory only, and the UI says so. Settings input is re-validated in main. | |
| Conversation | Per window; reset when format, base URL or model change (histories are not portable between providers); "New chat" resets it. | |
| Tests | Unit: `packages/ai-tools` (schemas, validator, every tool, house acceptance through a lock session). e2e: scripted mock Anthropic SSE server and mock Chat Completions server (`e2e/mock-ai.ts`) drive the real provider code — house with a red door (both formats), lock during the run, single Ctrl+Z, tool errors fed back, Stop cancels the request, API errors roll back, test connection, key never returned or stored in plain text. | No real API calls in CI. |

## Canvas: page edge and off-page content

| Topic | Decision | Why / revisit when |
|---|---|---|
| Page | The rendered `<svg>` is drawn as a page: checkerboard (transparency) inside, outlined, on a plain desk colour. | Users could not see where the drawing ends; shapes dragged past it looked cut off. |
| Off-page shapes | Shown (`overflow: visible`) and still selectable, but dimmed by a mask outside the page. Export and the saved file are unchanged: SVG crops to the viewBox. | Same model as Inkscape/Figma. Revisit: content far off-page is not in the scroll area; a "fit to content" zoom may be needed. |

## Phase 2, step 3: vision loop

| Topic | Decision | Why / revisit when |
|---|---|---|
| Tool | `render_snapshot` in `packages/ai-tools`: whole page, a region, or elements by id (with padding). PNG through the SDK's `exportPng` with new `region`, `maxSize` (1024 px) and `background` (white) options, so it also works headlessly with any rasterizer. The snapshot includes the turn's uncommitted edits. | Plan: the model verifies its own work. White background because transparent pixels are ambiguous to a model. |
| Limits | 6 snapshots per turn (on top of the 30 tool rounds per turn); over the limit the tool returns `SNAPSHOT_LIMIT` with a hint to finish. | Plan: cap iterations to prevent loops. |
| Capability | Setting "Model can see images" (default on). Off: the tool is not offered. Test connection sends a 1x1 PNG when it is on and reports a model that rejects images (HTTP 400/422). | Plan: disable `render_snapshot` for models without image input. Auto-detection would need a request per model change. |
| Wire format | Anthropic: image inside the `tool_result`. OpenAI-compatible: tool messages are text-only, so the tool result says "attached", and one user message after the tool results carries the images. | |
| History | Snapshots from earlier turns are replaced by a short note before the next turn. | Keeps requests small; old pictures are stale anyway. |
| Chat | Each snapshot shows as a thumbnail under its tool line, so the user sees what the AI saw. | |
| `dispatch` | Now async (snapshots are). | |

## AI settings: model picker and streaming gateways

| Topic | Decision | Why / revisit when |
|---|---|---|
| Model field | A combo box: the list comes from the endpoint (`GET /v1/models` via the Anthropic SDK; `GET {base}/models` for OpenAI-compatible, also Ollama's `{ models: [{ name }] }`), refreshed when format or URL change; any name can still be typed. | User request. |
| Streaming gateways | Requests send `stream: false`; if a gateway streams anyway (seen with a local proxy), the SSE chunks are assembled into one reply, tool calls included. | Real failure: "The server's reply is not a Chat Completions response: data: {…chunk…}". |

## Windows installer

| Topic | Decision | Why / revisit when |
|---|---|---|
| Wizard | Welcome → location → options (desktop / Start Menu shortcuts) → ready → install → finish with "Launch SVG Editor". Custom pages in `apps/desktop/build/installer.nsh` via electron-builder's NSIS hooks. | User's design. "Launch after install" is only on the finish page; the NSIS progress page shows no percentage. |
| Scope | Current user only: `%LOCALAPPDATA%\Programs\SVG Editor`, registered under HKCU, no admin prompt. The "for me / for all users" page is skipped (`customInstallMode`). The user can still browse to another folder they can write to. | v0.1.1 installed per machine to `C:\Program Files`, which requires an administrator password. Revisit if IT-managed, machine-wide installs are needed (e.g. an MSI). |
| CI | Silent install checks the folder, both shortcuts, that nothing was registered machine-wide, runs the installed app, then uninstalls and checks everything is gone. The wizard is also clicked through with a screenshot per page. | |

## AI drawing quality (after the first real test)

| Topic | Decision | Why / revisit when |
|---|---|---|
| Prompt | Plan the composition first; smooth C/S/A curves instead of chains of tiny Q segments; `<textPath>` for circular text; an original design "in the style of" a brand, not a copy of a trademark; critique each snapshot against the request and fix until it reads right or snapshots run out; say honestly what could still be improved. | First real run (a "logo like Starbucks" via a local gateway) stopped after one snapshot with a lumpy figure; the old prompt said "one or two checks are usually enough". |
| Snapshot size | Always scaled to 1024 px on the long side (`exportPng({ longSide })`), so small drawings are enlarged. | A 200x120 page was sent as 400x240 px, too small to judge details. |
| Chat text | Each model response in a turn starts a new paragraph. | Replies ran together ("…text ring.Created a circular…"). |
| Limits | Quality depends mostly on the model; the app cannot make a weak model draw well. | Compare models with the same request. |

## Phase 2, step 4: path editing

| Topic | Decision | Why / revisit when |
|---|---|---|
| Library | `svgpath` (MIT) in `packages/model` for parsing and normalizing path data. Pure JS, no DOM. | User's choice. It has no geometry kernel, so **boolean operations and simplify are not done**; they need paper.js or a polygon clipper (a later decision). |
| Commands | `pathEdit` (move end/control points by segment index; handles follow unless `handles: false`; moving a subpath start also moves an explicit closing point on it) and `convertToPath` (rect incl. rounded corners, circle, ellipse, line, polyline, polygon). Both compile to existing mutations, so undo, minimal text patches and the parser need no changes; the corpus fuzzer runs them. | Plan: `pathEdit` command. |
| Path data form | An edit rewrites that path's `d` in absolute form (H/V become L, S/T become C/Q, arcs stay arcs); nothing else in the file changes. | Node editing needs absolute points; only the edited attribute is touched. |
| New IDs | `convertToPath` creates a new node (a tag change is not a mutation); attributes keep their order, children and position are kept. | Revisit if stable IDs across conversion matter. |
| Canvas | Double-click a path (or Enter / Edit > Edit Path Nodes) shows nodes (squares) and control points (circles, dashed handle lines). A drag previews in the DOM and commits one `pathEdit` on release; Alt moves a point without its handles; snapping applies. Esc leaves; Delete does nothing in this mode. Edit > Convert to Path (Ctrl+Shift+C) converts the selection in one undo step and enters node editing for a single shape. | Same one-gesture-one-command rule as other canvas gestures. |
| Not yet | Adding/deleting nodes, changing segment types, booleans, simplify, headless bbox for paths (still needs the measure bridge). | |
| AI | Tools `convert_to_path`, `edit_path`; `get_element` includes a path's `segments`. | Parity with the UI. |

## Phase 2, step 4b: booleans and simplify (paper.js)

| Topic | Decision | Why / revisit when |
|---|---|---|
| Library | `paper` 0.12.18 (MIT), its `paper-core` build, in `packages/model`. Only its geometry is used (no view, no canvas); it runs headlessly in Node, verified. Adds ~0.4 MB to the renderer bundle. | User's choice; the plan says not to hand-roll bezier booleans. |
| `boolean` | union, subtract, intersect, exclude of sibling paths or basic shapes (any transforms), in stacking order: subtract = bottom minus the others (Inkscape "Difference", Illustrator "Minus Front"). Result: a new `<path>` in the bottom shape's coordinates, with its attributes (style, transform) and place; operands removed. One undo step. `EMPTY_RESULT` when nothing is left; groups and text are refused (`NOT_CONVERTIBLE`). | Coordinates of the bottom shape keep its transform and stroke width as they were. |
| `simplify` | Refits each subpath with fewer points; `tolerance` = largest deviation in the path's units (default 1). Returns node counts before and after. | |
| Output | Absolute path data, 3 decimals (paper's own output is normalized through `parsePath`/`formatPath`). | Readable files. |
| Emptiness | Judged by the result's path data, not its area: paper's area is signed and exclude's pieces can cancel to ~0. | Found while testing. |
| UI | New **Path** menu: Convert to Path, Edit Path Nodes, Union, Subtract, Intersect, Exclude, Simplify (Ctrl+L). Booleans have no shortcuts: Ctrl +/- are zoom. | |
| AI | Tools `combine_shapes`, `simplify_path`; the prompt suggests building outlines from simple shapes (a crescent = circle minus circle). | The logo test showed the AI faking shapes by stacking circles. |
| Main process | Imports `@svg-editor/ai-tools/definitions` (tool schemas, prompt, validator; no SDK). Importing the full package pulled paper.js and its Node shims (canvas, jsdom) into the main bundle and crashed the app at startup. An e2e test checks the main bundle needs only Electron and Node built-ins; `ui-parity.test.ts` checks the import. | |
| Deferred | Node add/delete and segment types: to the final polish (plan, Step 5). | User's call. |

## Redesign: editor and agent modes (Svelte)

| Topic | Decision | Why / revisit when |
|---|---|---|
| Framework | The renderer is Svelte 5 (runes) with `@sveltejs/vite-plugin-svelte`; icons from `@lucide/svelte` (per-icon imports), fonts Onest and Fragment Mono bundled with `@fontsource` (no network). The canvas engine (`canvas.ts`, `viewport.ts`, `render.ts`) is unchanged plain TS; Svelte components drive it through one `session` store. | User's choice after an approved mockup. The old hand-built DOM code had grown past what was easy to change. |
| Type checking | `svelte-check --tsgo --fail-on-warnings`. svelte-check does not accept TypeScript 7 yet, so the desktop package pins `typescript@~6` for it and gets TS 7 (`@typescript/native`) for `--tsgo`; the root stays on TS 7. | Drop the pin when svelte-check supports TS 7. |
| Modes | **Editor** (rail, code, canvas, inspector) and **Agent** (chat, canvas) over the same canvas. The other mode's panels are hidden, not unmounted, so the code editor, chat scroll and drafts survive a switch. The switch uses a View Transition. | Mockup. |
| Title bar | Custom (`titleBarStyle: "hidden"`, native window buttons via `titleBarOverlay` on Windows/Linux, traffic lights on macOS), coloured to match the theme. The native menu is kept for the OS but its accelerators are not registered: the page owns every shortcut, so the palette, menus and keys agree. | |
| Motion | Short (120–220 ms) ease-out transitions on dialogs, menus, tabs, the mode switch and turn steps; nothing loops except the "working" indicators. `prefers-reduced-motion` sets every duration to 0 and skips the View Transition. | User asked for careful UX and animation. |
| Recent files | Up to 8 in `userData/recent.json`. The page only sees an id, name, folder name and time; opening goes through the main process by id, so the page still never handles paths. | Same rule as Open/Save. |
| Inspector | Common properties first (X/Y scrub fields, fill/stroke with the document's colours, stroke width, opacity, text); every raw attribute stays under **All attributes**. X/Y move with `translateInRoot`, like a canvas drag. | Raw attribute lists were the whole panel before; hard to use. |
| Agent composer | Enter sends, Shift+Enter is a new line; Send is disabled while empty and replaced by Stop during a turn. A missing key opens Settings with the message. | |

## Phase 2, step 5: polish (first part)

| Topic | Decision | Why / revisit when |
|---|---|---|
| Hover highlight | Pointing at markup in the code pane, or at a row in Layers, draws a dashed outline around that element on the canvas (not a selection: no handles, nothing changes). Hidden during a gesture and for elements already selected. Uses the same `nodeAt` lookup as the code cursor, and only when code and model agree. | Plan: "hover in code = highlight on canvas". |
| Export | **Export…** (title bar, File menu, Ctrl+Shift+E) offers PNG, SVG formatted (one element per line, two-space indent) or SVG minified (no whitespace between tags), with the SVG sizes shown. Both SVG styles come from the SDK's `toSvg({ pretty })`; comments and the file's own formatting are not kept (Save keeps them). The copy never replaces the open file: choosing its path is refused with a message, since the editor would no longer match the disk. | Plan: "pretty-print/minify on export". Minify does not shorten numbers or path data, or drop editor metadata (Inkscape/Sodipodi); revisit if file size matters. |
| Failed agent steps | A failed step shows its reason on its own line; the turn's steps header says how many failed, so it shows even when collapsed. A step still running when a turn ends reads "Did not finish". The tool's `hint` is for the model and is not shown. | Plan: "surface failed AI commands clearly in chat". |
| Points (model) | New command `pathNode` (SDK `doc.pathNode`, AI tool `edit_path_nodes`): **insert** splits a segment at t without changing the outline (de Casteljau for curves, the SVG arc equations for arcs, the implicit closing line of a Z too); **delete** joins the two neighbouring segments (curves keep their outer handles; a closed subpath's start can be deleted); **node** `corner` pulls both handles into the point, `smooth` puts them on one tangent (neighbouring lines become curves); **segment** `line` / `curve` (arcs become cubics). Fewer than two points is refused (`TOO_FEW_POINTS`). One undo step each; in the corpus fuzzer. | Plan step 5 (deferred from step 4). No stored node types (like Inkscape's `sodipodi:nodetypes`): "smooth" is read from the geometry, handles in line within about half a degree. |
| Points (canvas) | While editing points: click a point to select it, Delete removes it (never the path), double-click the outline (within 8 px) adds a point, double-click a point switches corner / smooth. The inspector's **Point** section has Corner, Smooth, Delete point, and Straight line / Curve for the segment into the point. Dragging one handle of a smooth point turns the other with it (same length); Alt breaks the pair, as it moves a point alone. A new point is rounded to 2 decimals, like a drag, in the same undo step. | "Corner" pulls handles in (Illustrator's convert-to-corner) because a flag-only corner would not show in plain SVG. |
| Snap to shapes | While moving shapes, the selection's left / centre / right and top / middle / bottom snap to another shape's (or the page's) within 6 screen px, and a guide line shows the match. On by default, separate from Snap to grid (View menu, the canvas's view buttons, Settings); Alt while dragging turns it off for that drag. Targets are every other element's screen box (groups included; the moved shapes, their groups and their contents excluded), collected once per drag. | Plan step 5 "snapping/guides", read as snapping to the model's geometry; decisions.md had deferred "snapping to other objects' edges". Moves only: drawing and resizing do not snap to shapes yet. Rotated shapes snap by their axis-aligned box. |
| Scrub numbers in code | Alt+drag on a number inside an attribute value (sizes, path data, transforms, style) changes it: 2 px per step of the number's own precision (1 for "80", 0.1 for "1.5"), Shift x10. The canvas follows during the drag; the whole drag is one undo step (`beginBatch`); Esc cancels it. Holding Alt over a number shows a resize cursor. Ids, colours and text content are never scrubbed. | Plan step 5. Alt+drag replaces CodeMirror's rectangular selection only on numbers. [Likely] some Linux desktops use Alt+drag to move windows; revisit the modifier if that bites. |

## App updates

| Topic | Decision | Why / revisit when |
|---|---|---|
| Mechanism | `electron-updater` (bundled into the main process, like everything else; the package ships no node_modules) reading GitHub Releases of the public repository: no token. CI attaches `latest.yml` / `latest-linux.yml` and `.blockmap` files next to the installers; each build is checked to carry a feed that names its own installer, version and checksum, and the app its `app-update.yml`. | User's request; the repository is public. The main bundle grows from about 0.57 MB to 1.1 MB. |
| Platforms | Windows (the per-user NSIS installer, run silently: no admin prompt) and Linux (AppImage). **macOS: none** (no menu item, no Settings section): builds are unsigned and macOS only installs signed updates. | User: "skip for mac". Revisit with an Apple Developer ID. |
| Behaviour | A quiet check 4 s after start (Settings > Updates can turn it off); the download runs in the background with progress in the status bar; then **Restart to update** in the title bar. Restarting waits for an agent turn and saves the drawing first; otherwise the update installs when the app quits. File > Check for Updates… (and the palette) reports "latest version" or the error. | |
| Trust | Downloads are checked against the SHA-512 in the feed. Installers are not code-signed, so what users install is whatever the repository's releases hold: protect the GitHub account (2FA). | |
| Tests | e2e with a local feed (`SVG_EDITOR_UPDATE_URL`, test only; it checks but does not download): a newer version is reported, the same version is "latest", a development build says updates need the installed app, the automatic check can be turned off. Not tested automatically: downloading and installing a real release; that needs two published releases. | |

## Performance (large files)

Measured with the SDK (paths, one attribute each changed, Node 22): opening and every command scale linearly, about 0.1 s at 20,000 elements (1.9 MB). A code edit did not.

| Topic | Decision | Why / revisit when |
|---|---|---|
| Code edits | `reconcile` (keeping IDs across a code edit) aligned every old child with every new child, rebuilding attribute sets per pair, with an n x m table: 1.1 s at 1,000 siblings, 29 s at 5,000, 8 min at 20,000. Now identical runs at the start and end of each child list match directly (an edit usually changes one spot); only the changed middle is aligned for best similarity, with attributes computed once per node; above 250,000 pairs the middle is matched in order by tag (IDs may reset where tags differ, as the plan accepts for big rewrites). The breadth-first queue no longer uses `shift()`. Result: 20 ms at 1,000, 0.1 s at 5,000, 0.66 s at 20,000. A test holds 5,000 siblings under 2 s. | Plan risk 5: "test a large file early". |
| App side | At 5,000 elements one change costs about 180 ms in the app: the full canvas rebuild about 80 ms, Svelte updates (5,000 layer rows) about 80 ms. | Next if large files matter: virtualize the Layers list, then patch the canvas per mutation instead of rebuilding it. |

