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
