# @svg-editor/sdk

The public API for building and editing SVG documents. The desktop app is built on it, headless scripts use it, and in Phase 2 the AI tools will call it. Pure TypeScript: no DOM, no Electron, runs in Node.

```ts
import { createEditor } from "@svg-editor/sdk";

const editor = createEditor({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>' });
const { doc } = editor;

const id = doc.add("rect", { x: 10, y: 10, width: 100, height: 60, fill: "#4f46e5" });
doc.set(id, { rx: 8 });
doc.transform(id, { rotate: 15, origin: "center" });

editor.batch(() => {
  // several changes, one undo step
  const label = doc.addText("Hello", { x: 20, y: 90 });
  doc.group([id, label]);
});

editor.undo();
console.log(editor.text); // the document, original formatting kept
```

A complete script: [`examples/bar-chart.ts`](examples/bar-chart.ts) builds a chart from data.

```sh
pnpm --filter @svg-editor/sdk build
node --experimental-strip-types packages/sdk/examples/bar-chart.ts chart.svg
```

## Concepts

- **Node IDs** (`"n_12"`) are stable across edits, undo/redo and (usually) code edits. They are internal: nothing is added to your SVG. The `id` attribute is ordinary document content.
- **Every change is a command** and every command is atomic: it applies completely or not at all. `batch()` groups commands into one undo step.
- **Two kinds of text.** `editor.text` is the document as written, with its formatting, comments and attribute order, patched minimally on every change. `editor.toSvg()` is a fresh serialization.
- **Errors are `SvgEditorError`** with a stable `code`, a `message` and a `hint` (what to do instead). They serialize to plain JSON with `toJSON()`.

## API

### `createEditor(options?)`

| Option | |
|---|---|
| `svg` | Initial text. Defaults to an empty 400x300 drawing. Throws `PARSE_ERROR` (with `.parse.line` / `.column`) if not well-formed. |
| `rasterize` | `(svg, { width, height }) => Promise<Uint8Array>`: enables `exportPng()`. |
| `measure` | `(id) => BBox \| null` in root units: bounding boxes for paths and text (needs a renderer). |

### `editor.doc` (writes)

All throw `SvgEditorError`; none half-apply. Attribute values may be numbers (written with at most 6 decimals).

| Method | Returns |
|---|---|
| `add(tag, attrs?, { parent?, index? }?)` | new ID (appends to the root by default) |
| `addText(text, attrs?, at?)` | new `<text>` ID (one undo step) |
| `set(id, { name: value \| null })` | `null` removes an attribute |
| `delete(id \| ids)` | |
| `move(id, parent, index)` | `index` is the final position among the new parent's children |
| `group(ids)` / `ungroup(id)` | group ID / child IDs. Ungroup refuses (`UNGROUP_LOSSY`) if the group's attributes cannot move to its children without changing the rendering. |
| `transform(id, { translate?, scale?, rotate?, origin?, space? })` | new `transform` value. `origin`: `[x, y]` or `"center"`. `space`: `"parent"` (default) or `"local"` (the element's own axes). |
| `setText(id, text)` | text content of an element or text node |

### `editor.doc` (reads)

| Method | |
|---|---|
| `getTree(id?)`, `getNode(id)`, `has(id)` | plain data, never DOM |
| `query({ tag?, attr?, within? })` | IDs in document order; `attr: { stroke: true }` means "has attribute" |
| `topLevel()` | what a click or marquee selects: children of the root and of Inkscape layers |
| `getBBox(id, "local" \| "root")` | headless for rect, circle, ellipse, line, polyline, polygon, image and groups of them; paths and text need `measure` |
| `pointToRoot(id, [x, y])` | element user space to root user space |

### Editor

| Member | |
|---|---|
| `text`, `setText(text)` | source text; `setText` is a code edit (IDs kept where recognizable, one undo step) |
| `toSvg({ pretty? })` | fresh serialization |
| `onChange(fn)` | `{ text, edits, origin: "code" \| "model" }` after every change, with minimal text edits |
| `undo()`, `redo()`, `canUndo()`, `canRedo()` | |
| `batch(fn)` | one undo step; rolls back if `fn` throws |
| `beginBatch()` | same, across `await`s: `commit()` or `rollback()` |
| `execute(command)` | the raw command form, never throws: `{ ok, result }` or `{ ok: false, error }` |
| `select(ids)`, `getSelection()`, `clearSelection()`, `selectInRect(rect)`, `onSelectionChange(fn)` | selection (deleted nodes drop out automatically) |
| `getSourceRange(id)`, `nodeAt(offset)` | map nodes to and from source offsets |
| `intrinsicSize()`, `exportPng({ scale?, region?, maxSize?, background? })` | PNG needs `rasterize`. `region` is a rectangle in viewBox units (may reach past the page), `maxSize` caps the longer side in pixels, `background` is a CSS colour under the drawing. |
| `setBridges({ rasterize?, measure? })` | plug renderer capabilities in later |

### Locking (one writer at a time, e.g. an AI turn)

```ts
await editor.runLocked({ reason: "ai", label: "AI is drawing…", timeoutMs: 120_000 }, async (session) => {
  const reply = await fetch(url, { signal: session.signal as AbortSignal }); // cancelled by Stop
  session.doc.add("rect", { width: 10, height: 10 });                       // only the session can write
});
```

| Member | |
|---|---|
| `lock({ reason, label?, timeoutMs? })` | returns a `LockSession`. Until it ends, writes not made through the session throw `LOCKED` (reads and selection still work). The whole session is one undo step. |
| `runLocked(options, fn)` | commits when `fn` finishes, rolls back when it throws, always unlocks. If stopped meanwhile, rejects with `LOCK_STOPPED`. |
| `session.doc`, `session.execute`, `session.batch` | the holder's write access; `LOCK_RELEASED` after the session ends |
| `session.commit()`, `session.rollback()`, `session.stop({ keep? })` | `stop` aborts `session.signal`, then discards (default) or keeps the partial work |
| `editor.stopLock({ keep? })` | stop whoever holds the lock (the UI's Stop button) |
| `editor.lockInfo`, `editor.onLockChange(fn)` | for banners |

### Error codes

`PARSE_ERROR`, `NOT_FOUND`, `INVALID_COMMAND`, `UNKNOWN_OP`, `INVALID_TAG`, `INVALID_ATTR`, `ROOT_NOT_ALLOWED`, `NOT_AN_ELEMENT`, `INDEX_OUT_OF_RANGE`, `CYCLE`, `DIFFERENT_PARENTS`, `NOT_A_GROUP`, `UNGROUP_LOSSY`, `EMPTY_TRANSFORM`, `INVALID_TRANSFORM`, `BBOX_UNAVAILABLE`, `HAS_ELEMENT_CHILDREN`, `BATCH_FAILED` (with `path` to the failing command), `NO_RASTERIZER`, `EXPORT_FAILED`, `LOCKED`, `LOCK_RELEASED`, `LOCK_STOPPED`.

## UI parity

The desktop app uses only this package for documents; [`test/ui-parity.test.ts`](test/ui-parity.test.ts) enforces it and maps every UI action to its SDK call. View-only features (zoom, pan, grid, snapping) are not part of the SDK: snapping only rounds the coordinates you pass in.
