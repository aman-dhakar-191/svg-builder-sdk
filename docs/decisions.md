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
| Change notifications | Not in step 1. `version` increments on every change. | Event shape should be designed with its consumer (step 2 patching / step 3 sync). |
