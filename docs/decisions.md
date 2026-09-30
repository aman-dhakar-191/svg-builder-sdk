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
