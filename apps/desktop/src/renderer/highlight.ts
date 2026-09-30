import { StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/** Replaces the highlighted source ranges (the canvas selection). */
export const setHighlights = StateEffect.define<{ from: number; to: number }[]>();

const mark = Decoration.mark({ class: "cm-selected-node" });

/** Marks the source of selected nodes without moving the user's cursor. */
export const selectionHighlight = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setHighlights)) continue;
      const ranges: Range<Decoration>[] = e.value
        .filter((r) => r.to > r.from && r.to <= tr.state.doc.length)
        .sort((a, b) => a.from - b.from)
        .map((r) => mark.range(r.from, r.to));
      next = Decoration.set(ranges);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});
