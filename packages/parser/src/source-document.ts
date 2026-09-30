import {
  createDocument,
  escapeAttr,
  escapeText,
  serialize,
  TEXT_TAG,
  type HistoryEvent,
  type Mutation,
  type NodeId,
  type SvgDocument,
  type SvgNode,
} from "@svg-editor/model";
import { parseSvg, type ParsedAttr, type ParsedElement, type ParsedNode, type ParseError } from "./parse.js";
import { reconcile } from "./reconcile.js";
import { toInputTree, zip, type SourceMap } from "./source-map.js";

/** Replace [from, to) of the text *before* the change with `insert` (CodeMirror's shape). */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface TextChange {
  /** Non-overlapping edits, all in coordinates of the text before this change. */
  edits: TextEdit[];
  text: string;
  /** How the edit was produced. "subtree" / "document" mean formatting was lost somewhere. */
  method: "patch" | "subtree" | "document" | "code";
}

export type SetTextResult =
  | { ok: true; kept: number; created: number; removed: number }
  | { ok: false; error: ParseError };

export type OpenResult = { ok: true; source: SourceDocument } | { ok: false; error: ParseError };

/** Parses SVG text into a model and keeps the two in sync as the model changes. */
export function openSvg(text: string): OpenResult {
  const parsed = parseSvg(text);
  if (!parsed.ok) return parsed;
  const doc = createDocument({ tree: toInputTree(parsed.root) });
  const map = zip(parsed.root, doc.root, (id) => doc.getNode(id));
  if (!map) throw new Error("internal: fresh document does not match its own parse");
  return { ok: true, source: new SourceDocument(doc, text, parsed.root, map) };
}

/** Whitespace taken out together with a node, so it can go back on the same side. */
interface Spacing {
  leading?: string | undefined;
  trailing?: string | undefined;
  /** Whitespace left in place just before / after the removed range. */
  gapBefore?: string;
  gapAfter?: string;
}

interface Stashed extends Spacing {
  node: ParsedNode;
  body: string;
  /** Whether it sat inside a text container (whitespace means different things there). */
  inText: boolean;
}

const STASH_LIMIT = 500;

export class SourceDocument {
  private _text: string;
  private root: ParsedElement;
  private map: SourceMap;
  private readonly newline: string;
  private readonly indentUnit: string;
  private readonly listeners = new Set<(change: TextChange) => void>();
  /** Removed source, so undoing a delete restores the original bytes. */
  private readonly stash = new Map<string, Stashed>();
  private readonly attrStash = new Map<string, string>();
  /**
   * Original tails ("/>", "></g>", ">\n</g>") of empty elements we added a
   * child to; restored when they become empty again.
   */
  private readonly opened = new Map<NodeId, string>();
  private _fallbacks = 0;
  /** True while applying a code edit: the text is already right, so no patching. */
  private suppress = false;
  /** Text and model disagree mid-transaction; resolved at the next history boundary. */
  private stale = false;
  /** Text at the last history boundary, and the texts around each undo step. */
  private boundaryText: string;
  private readonly entryTexts = new WeakMap<object, { before: string; after: string }>();

  constructor(
    readonly doc: SvgDocument,
    text: string,
    root: ParsedElement,
    map: SourceMap,
  ) {
    this._text = text;
    this.root = root;
    this.map = map;
    this.newline = text.includes("\r\n") ? "\r\n" : "\n";
    this.indentUnit = detectIndent(text);
    this.boundaryText = text;
    doc.onMutation((m) => this.onMutation(m));
    doc.onHistory((e) => this.onHistory(e));
  }

  get text(): string {
    return this._text;
  }

  /** Number of changes that could not be patched minimally. Should stay 0. */
  get fallbacks(): number {
    return this._fallbacks;
  }

  onChange(listener: (change: TextChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Source offsets of a node, e.g. to highlight it in the code pane. */
  getSource(id: NodeId): { start: number; end: number } | undefined {
    const n = this.map.byId.get(id);
    return n && { start: n.start, end: n.end };
  }

  // ---------------------------------------------------------------- core

  /**
   * Applies text typed in the code pane: parse, keep node IDs via reconcile,
   * and replace the model content as one undo step. On a parse error nothing
   * changes (the model keeps the last good state) and the error is returned.
   */
  setText(text: string): SetTextResult {
    if (text === this._text) return { ok: true, kept: 0, created: 0, removed: 0 };
    const parsed = parseSvg(text);
    if (!parsed.ok) return parsed;
    const rec = reconcile(this.doc, parsed.root);
    const before = this._text;
    const tx = this.doc.beginTransaction();
    this.suppress = true;
    let map: SourceMap | null = null;
    try {
      const r = this.doc.execute({ op: "replace", tree: rec.tree });
      if (r.ok) map = zip(parsed.root, this.doc.root, (id) => this.doc.getNode(id));
    } finally {
      if (!map) {
        tx.rollback();
        this.suppress = false;
      }
    }
    if (!map) throw new Error("internal: parsed text could not be loaded into the model");
    this._text = text;
    this.root = parsed.root;
    this.map = map;
    this.suppress = false;
    tx.commit();
    for (const l of this.listeners) l({ edits: [diffEdit(before, text)], text, method: "code" });
    return { ok: true, kept: rec.kept, created: rec.created, removed: rec.removed.length };
  }

  private onMutation(m: Mutation): void {
    if (this.suppress || this.stale) return;
    let edits: TextEdit[] | null = null;
    try {
      edits = this.patchFor(m);
    } catch {
      edits = null;
    }
    if (edits && this.commit(edits, "patch")) return;
    this._fallbacks++;
    const scope = this.fallbackScope(m);
    if (scope) {
      const el = this.map.byId.get(scope)!;
      const edit = { from: el.start, to: el.end, insert: this.serializeSubtree(scope, lineIndent(this._text, el.start) ?? "") };
      if (this.commit([edit], "subtree")) return;
    }
    const whole = { from: 0, to: this._text.length, insert: this.doc.toSvg({ pretty: true, indent: this.indentUnit }).replace(/\n/g, this.newline) };
    // Not representable right now (possible only mid-transaction); the next
    // history boundary snaps to recorded text or regenerates it.
    if (!this.commit([whole], "document")) this.stale = true;
  }

  /**
   * Keeps the text history aligned with the model's: every model state that
   * history can return to has exactly one text. Undo, redo and rollback are
   * patched mutation by mutation (so each step stays valid), then snapped to
   * the recorded text, which makes them byte-exact even around comments.
   */
  private onHistory(e: HistoryEvent): void {
    switch (e.kind) {
      case "commit":
        this.entryTexts.set(e.entry, { before: this.boundaryText, after: this._text });
        break;
      case "discard":
        this.snapTo(this.boundaryText);
        break;
      case "undo":
      case "redo": {
        const rec = this.entryTexts.get(e.entry);
        if (rec) this.snapTo(e.kind === "undo" ? rec.before : rec.after);
        break;
      }
    }
    if (this.stale) this.resync();
    this.boundaryText = this._text;
  }

  private resync(): void {
    const parsed = parseSvg(this._text);
    if (parsed.ok && this.commit([], "patch")) return;
    const whole = { from: 0, to: this._text.length, insert: this.doc.toSvg({ pretty: true, indent: this.indentUnit }).replace(/\n/g, this.newline) };
    this.commit([whole], "document");
  }

  private snapTo(target: string): void {
    if (this._text === target) return;
    // If the recorded text no longer matches the model, keep the patched text.
    this.commit([diffEdit(this._text, target)], "patch");
  }

  /** Applies edits, then re-parses and checks the text still matches the model. */
  private commit(edits: TextEdit[], method: TextChange["method"]): boolean {
    const text = applyEdits(this._text, edits);
    if (text === null) return false;
    const parsed = parseSvg(text);
    if (!parsed.ok) return false;
    const map = zip(parsed.root, this.doc.root, (id) => this.doc.getNode(id));
    if (!map) return false;
    this._text = text;
    this.root = parsed.root;
    this.map = map;
    this.stale = false;
    if (edits.length > 0) for (const l of this.listeners) l({ edits, text, method });
    return true;
  }

  private patchFor(m: Mutation): TextEdit[] {
    switch (m.kind) {
      case "attrs":
        return this.attrEdits(m.id, m.attrs);
      case "text": {
        const t = this.src(m.id);
        return [{ from: t.start, to: t.end, insert: this.escapeText(m.text) }];
      }
      case "remove": {
        const node = this.src(m.id);
        const r = this.removal(m.id);
        const { edits: _, ...spacing } = r;
        this.remember(`n:${m.id}`, { node, body: this._text.slice(node.start, node.end), inText: this.map.textContext.has(this.map.parentOf.get(m.id)!), ...spacing });
        return r.edits;
      }
      case "insert": {
        const top = m.nodes[0]!;
        const stashed = this.stash.get(`n:${top.id}`);
        const snapshot = new Map(m.nodes.map((n) => [n.id, n]));
        if (stashed && stashed.inText === this.map.textContext.has(m.parent) && sameContent(stashed.node, top.id, snapshot)) {
          return this.insertEdits(m.parent, top.id, () => stashed.body, stashed);
        }
        const inText = top.tag === TEXT_TAG || this.map.textContext.has(m.parent);
        return this.insertEdits(m.parent, top.id, (indent) =>
          inText
            ? serialize((id) => snapshot.get(id)!, top.id)
            : this.reindent(serialize((id) => snapshot.get(id)!, top.id, { pretty: true, indent: this.indentUnit }), indent),
        );
      }
      case "move": {
        const node = this.src(m.id);
        const fromText = this.map.textContext.has(this.map.parentOf.get(m.id)!);
        const toText = this.map.textContext.has(m.parent);
        // Crossing into or out of a text container changes what whitespace means: re-serialize.
        const body = fromText === toText ? this._text.slice(node.start, node.end) : this.serializeFor(m.id, toText);
        const removal = this.removal(m.id);
        // Remember the spacing at the old spot so moving back (undo) restores it exactly.
        const { edits: __, ...spacing } = removal;
        this.remember(`m:${this.positionKey(m.id)}`, { node, body, inText: fromText, ...spacing });
        const siblings = this.doc.getNode(m.parent)!.children;
        const i = siblings.indexOf(m.id);
        const stashedBack = this.stash.get(`m:${m.id}|${m.parent}|${siblings[i - 1]}|${siblings[i + 1]}`);
        const back = stashedBack && stashedBack.inText === toText ? stashedBack : undefined;
        return [...removal.edits, ...this.insertEdits(m.parent, m.id, () => body, back)];
      }
    }
  }

  // --------------------------------------------------------------- pieces

  /** "id|parent|prev|next" for the node's current (pre-change) place in the source. */
  private positionKey(id: NodeId): string {
    const parentId = this.map.parentOf.get(id)!;
    const siblings = this.el(parentId).children.map((c) => this.map.idOf.get(c)).filter((c) => c !== undefined);
    const i = siblings.indexOf(id);
    return `${id}|${parentId}|${siblings[i - 1]}|${siblings[i + 1]}`;
  }

  private src(id: NodeId): ParsedNode {
    const n = this.map.byId.get(id);
    if (!n) throw new Error(`internal: no source for ${id}`);
    return n;
  }

  private el(id: NodeId): ParsedElement {
    const n = this.src(id);
    if (n.kind !== "element") throw new Error(`internal: ${id} is not an element`);
    return n;
  }

  private remember(key: string, value: Stashed): void {
    this.stash.delete(key);
    this.stash.set(key, value);
    if (this.stash.size > STASH_LIMIT) this.stash.delete(this.stash.keys().next().value!);
  }

  private escapeText(s: string): string {
    return escapeText(s).replace(/\n/g, this.newline);
  }

  private reindent(s: string, indent: string): string {
    return s.replace(/\n/g, this.newline + indent);
  }

  /**
   * Edits that take a node out of the text. Outside text, a node alone on its
   * line takes the line with it; an inline node takes the whitespace on one
   * side. A parent we opened from "<g/>" collapses back once it is empty.
   */
  private removal(id: NodeId): Spacing & { edits: TextEdit[] } {
    const node = this.src(id);
    const parentId = this.map.parentOf.get(id)!;
    const t = this._text;
    let from = node.start;
    let to = node.end;
    let leading: string | undefined;
    let trailing: string | undefined;
    const pSiblings = this.el(parentId).children;
    const pi = pSiblings.indexOf(node);
    const touchesText = (n: ParsedNode | undefined) => n?.kind === "text" && this.map.idOf.has(n);
    const textBefore = touchesText(pSiblings[pi - 1]);
    const textAfter = touchesText(pSiblings[pi + 1]);
    if (node.kind === "element" && !this.map.textContext.has(parentId) && !textBefore && !textAfter) {
      const ls = t.lastIndexOf("\n", node.start - 1) + 1;
      const restOfLine = /^[ \t]*(\r?\n|$)/.test(t.slice(node.end, node.end + 200));
      if (ls > 0 && lineIndent(t, node.start) !== null && restOfLine) {
        from = t[ls - 2] === "\r" ? ls - 2 : ls - 1;
        leading = t.slice(from, node.start);
      } else {
        const after = /^[ \t\r\n]+/.exec(t.slice(node.end))?.[0] ?? "";
        const before = /[ \t\r\n]+$/.exec(t.slice(0, node.start))?.[0] ?? "";
        if (after && !after.includes("\n") && !t.startsWith("</", node.end + after.length)) {
          to = node.end + after.length;
          trailing = after;
        } else if (before) {
          from = node.start - before.length;
          leading = before;
        }
      }
    }
    if (node.kind === "element" && !this.map.textContext.has(parentId) && textBefore !== textAfter) {
      // Formatting whitespace on the far side would otherwise join the text.
      const parentEl = this.el(parentId);
      if (textAfter) from = wsRunBefore(t, node.start, parentEl.openEnd)[0];
      else to = wsRunAfter(t, node.end, parentEl.closeStart)[1];
    }
    const tail = this.opened.get(parentId);
    const parent = this.el(parentId);
    if (tail !== undefined && this.doc.getNode(parentId)!.children.length === 0) {
      const rest = t.slice(parent.openEnd, from) + t.slice(to, parent.closeStart);
      if (/^[ \t\r\n]*$/.test(rest)) {
        this.opened.delete(parentId);
        return {
          edits: [{ from: parent.attrsEnd, to: parent.end, insert: tail }],
          leading: t.slice(parent.openEnd, node.start),
          trailing: t.slice(node.end, parent.closeStart),
        };
      }
    }
    const gapBefore = /[ \t\r\n]*$/.exec(t.slice(0, from))![0];
    const gapAfter = /^[ \t\r\n]*/.exec(t.slice(to))![0];
    return { edits: [{ from, to, insert: "" }], leading, trailing, gapBefore, gapAfter };
  }

  /**
   * Edits that place `body` as child `childId` of `parentId`, using the model's
   * post-change sibling order and the pre-change source positions. With
   * `spacing` (whitespace captured when the node was taken out), exactly that
   * whitespace is put back; otherwise formatting follows the neighbours.
   */
  private insertEdits(parentId: NodeId, childId: NodeId, body: (indent: string) => string, spacing?: Spacing): TextEdit[] {
    if (this.doc.getNode(childId)!.tag === TEXT_TAG && !this.map.textContext.has(parentId)) {
      return this.insertLooseText(parentId, childId, body(""));
    }
    const siblings = this.doc.getNode(parentId)!.children;
    const idx = siblings.indexOf(childId);
    const prev = siblings[idx - 1] === undefined ? undefined : this.src(siblings[idx - 1]!);
    const next = siblings[idx + 1] === undefined ? undefined : this.src(siblings[idx + 1]!);
    const el = this.el(parentId);
    const t = this._text;
    const at = (pos: number, insert: string): TextEdit[] => [{ from: pos, to: pos, insert }];

    const nextIsText = siblings[idx + 1] !== undefined && this.doc.getNode(siblings[idx + 1]!)!.tag === TEXT_TAG;
    const prevIsText = siblings[idx - 1] !== undefined && this.doc.getNode(siblings[idx - 1]!)!.tag === TEXT_TAG;
    if (spacing && (prevIsText || nextIsText)) spacing = undefined;
    if (spacing) {
      const { leading = "", trailing, gapBefore, gapAfter } = spacing;
      const b = body(indentOf(leading));
      if (gapBefore !== undefined && gapAfter !== undefined) {
        // Put it back at the exact split point of the whitespace it was taken from.
        const runs: [number, number][] = [];
        if (next) runs.push(wsRunBefore(t, next.start, prev ? prev.end : el.openEnd));
        if (prev) runs.push(wsRunAfter(t, prev.end, next ? next.start : el.closeStart));
        for (const [lo, hi] of runs) {
          if (t.slice(lo, hi) === gapBefore + gapAfter) return at(lo + gapBefore.length, leading + b + (trailing ?? ""));
        }
      }
      if (trailing !== undefined && next) return at(next.start, b + trailing);
      if (prev) return at(prev.end, leading + b);
      if (next) {
        let pos = next.start;
        while (pos > el.openEnd && /[ \t\r\n]/.test(t[pos - 1]!)) pos--;
        return at(pos, leading + b);
      }
      return this.intoEmpty(parentId, el, leading + b + (trailing ?? ""));
    }

    const formatted = !this.map.textContext.has(parentId) && !prevIsText && !nextIsText;
    const nl = this.newline;
    if (next && !prev) {
      const ind = formatted ? lineIndent(t, next.start) : null;
      return at(next.start, body(ind ?? "") + (ind === null ? "" : nl + ind));
    }
    if (prev) {
      const ind = formatted ? lineIndent(t, prev.start) : null;
      return at(prev.end, (ind === null ? "" : nl + ind) + body(ind ?? ""));
    }
    if (!formatted) return this.intoEmpty(parentId, el, body(""));
    const parentIndent = lineIndent(t, el.start) ?? "";
    const childIndent = parentIndent + this.indentUnit;
    const hasNewline = !el.selfClosing && /\n/.test(t.slice(el.openEnd, el.closeStart));
    return this.intoEmpty(parentId, el, nl + childIndent + body(childIndent) + (hasNewline ? "" : nl + parentIndent));
  }

  /**
   * Text outside text containers: formatting whitespace next to it would be
   * read back as part of it, so the text replaces the whitespace around it.
   */
  private insertLooseText(parentId: NodeId, childId: NodeId, body: string): TextEdit[] {
    const siblings = this.doc.getNode(parentId)!.children;
    const idx = siblings.indexOf(childId);
    const el = this.el(parentId);
    if (el.selfClosing) return this.intoEmpty(parentId, el, body);
    const prev = siblings[idx - 1] === undefined ? undefined : this.src(siblings[idx - 1]!);
    const next = siblings[idx + 1] === undefined ? undefined : this.src(siblings[idx + 1]!);
    const lo = prev ? prev.end : next ? wsRunBefore(this._text, next.start, el.openEnd)[0] : el.openEnd;
    const hi = wsRunAfter(this._text, lo, next ? next.start : el.closeStart)[1];
    if (!prev && !next && !this.opened.has(parentId)) this.opened.set(parentId, this._text.slice(el.attrsEnd, el.end));
    return [{ from: lo, to: hi, insert: body }];
  }

  /** Puts `content` into an element with no model children, opening "<g/>" if needed. */
  private intoEmpty(parentId: NodeId, el: ParsedElement, content: string): TextEdit[] {
    const t = this._text;
    if (/^[ \t\r\n]*$/.test(t.slice(el.openEnd, el.closeStart)) && !this.opened.has(parentId)) {
      this.opened.set(parentId, t.slice(el.attrsEnd, el.end));
    }
    if (el.selfClosing) return [{ from: el.attrsEnd, to: el.end, insert: `>${content}</${el.tag}>` }];
    return [{ from: el.openEnd, to: el.openEnd, insert: content }];
  }

  private attrEdits(id: NodeId, next: Record<string, string>): TextEdit[] {
    const el = this.el(id);
    const t = this._text;
    const old = new Map(el.attrs.map((a) => [a.name, a]));
    const newKeys = Object.keys(next);
    const kept = el.attrs.filter((a) => a.name in next).map((a) => a.name);
    if (kept.join("\0") !== newKeys.filter((k) => old.has(k)).join("\0")) {
      // Surviving attributes changed order: rewrite the attribute list.
      const all = newKeys.map((k) => ` ${k}="${escapeAttr(next[k]!)}"`).join("");
      return [{ from: el.nameEnd, to: el.attrsEnd, insert: all }];
    }
    const edits: TextEdit[] = [];
    for (const a of el.attrs) {
      if (!(a.name in next)) {
        let from = a.start;
        while (from > el.nameEnd && /[ \t\r\n]/.test(t[from - 1]!)) from--;
        this.attrStash.set(`${id}\0${a.name}\0${a.value}`, t.slice(from, a.end));
        edits.push({ from, to: a.end, insert: "" });
      } else if (next[a.name] !== a.value) {
        edits.push({ from: a.valueStart, to: a.valueEnd, insert: escapeAttr(next[a.name]!, a.quote) });
      }
    }
    let anchor: ParsedAttr | undefined;
    const added: Record<number, string> = {};
    for (const k of newKeys) {
      const existing = old.get(k);
      if (existing) {
        anchor = existing;
        continue;
      }
      const at = anchor ? anchor.end : el.nameEnd;
      const raw = this.attrStash.get(`${id}\0${k}\0${next[k]}`) ?? ` ${k}="${escapeAttr(next[k]!)}"`;
      added[at] = (added[at] ?? "") + raw;
    }
    for (const [at, insert] of Object.entries(added)) edits.push({ from: Number(at), to: Number(at), insert });
    return edits;
  }

  /** Smallest element that contains everything a mutation touched. */
  private fallbackScope(m: Mutation): NodeId | null {
    const has = (id: NodeId | undefined): id is NodeId => id !== undefined && this.doc.getNode(id) !== undefined && this.map.byId.get(id)?.kind === "element";
    const ancestors = (id: NodeId): NodeId[] => {
      const out: NodeId[] = [];
      for (let cur: NodeId | undefined = id; cur !== undefined; cur = this.map.parentOf.get(cur)) out.push(cur);
      return out;
    };
    let ids: (NodeId | undefined)[];
    switch (m.kind) {
      case "attrs":
        ids = [m.id];
        break;
      case "text":
      case "remove":
        ids = [this.map.parentOf.get(m.id)];
        break;
      case "insert":
        ids = [m.parent];
        break;
      case "move":
        ids = [this.map.parentOf.get(m.id), m.parent];
        break;
    }
    if (!ids.every(has)) return null;
    const chains = ids.map(ancestors);
    const common = chains[0]!.find((a) => chains.every((c) => c.includes(a)));
    return common ?? null;
  }

  /** Model subtree as text for a context: compact inside text containers, indented elsewhere. */
  private serializeFor(id: NodeId, inText: boolean): string {
    const get = (nid: NodeId): SvgNode => ({ ...this.doc.getNode(nid)! });
    return inText ? serialize(get, id) : serialize(get, id, { pretty: true, indent: this.indentUnit }).replace(/\n/g, this.newline);
  }

  private serializeSubtree(id: NodeId, indent: string): string {
    const get = (nid: NodeId): SvgNode => {
      const n = this.doc.getNode(nid)!;
      return { ...n };
    };
    const inText = this.map.textContext.has(id);
    return inText ? serialize(get, id) : this.reindent(serialize(get, id, { pretty: true, indent: this.indentUnit }), indent);
  }
}

// ------------------------------------------------------------------ helpers

function wsRunBefore(t: string, end: number, limit: number): [number, number] {
  let lo = end;
  while (lo > limit && /[ \t\r\n]/.test(t[lo - 1]!)) lo--;
  return [lo, end];
}

function wsRunAfter(t: string, start: number, limit: number): [number, number] {
  let hi = start;
  while (hi < limit && /[ \t\r\n]/.test(t[hi]!)) hi++;
  return [start, hi];
}

/** The indentation at the end of a whitespace run ("\n    " -> "    "). */
function indentOf(ws: string): string {
  return /[ \t]*$/.exec(ws)![0];
}

/** Indentation of the line `offset` is on, if only whitespace precedes it there. */
export function lineIndent(text: string, offset: number): string | null {
  const ls = text.lastIndexOf("\n", offset - 1) + 1;
  const ws = text.slice(ls, offset);
  return /^[ \t]*$/.test(ws) ? ws : null;
}

function detectIndent(text: string): string {
  const m = /\n([ \t]+)</.exec(text);
  if (!m) return "  ";
  const ws = m[1]!;
  return ws.startsWith("\t") ? "\t" : ws.length <= 4 ? ws : "  ";
}

/** One edit turning `a` into `b`: the differing middle between common prefix and suffix. */
export function diffEdit(a: string, b: string): TextEdit {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { from: pre, to: a.length - suf, insert: b.slice(pre, b.length - suf) };
}

/** Applies non-overlapping edits given in original coordinates. Null if they overlap. */
export function applyEdits(text: string, edits: TextEdit[]): string | null {
  const sorted = edits
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.from - b.e.from || a.e.to - b.e.to || a.i - b.i)
    .map((x) => x.e);
  let out = "";
  let cursor = 0;
  for (const e of sorted) {
    if (e.from < cursor || e.to < e.from || e.to > text.length) return null;
    out += text.slice(cursor, e.from) + e.insert;
    cursor = e.to;
  }
  return out + text.slice(cursor);
}

/** Does a stashed parse subtree still describe exactly this model snapshot? */
function sameContent(p: ParsedNode, id: NodeId, nodes: Map<NodeId, SvgNode>): boolean {
  const n = nodes.get(id);
  if (!n) return false;
  if (p.kind === "text") return n.tag === TEXT_TAG && n.text === p.text;
  if (n.tag !== p.tag) return false;
  const attrs = Object.entries(n.attrs);
  if (attrs.length !== p.attrs.length || attrs.some(([k, v], i) => p.attrs[i]!.name !== k || p.attrs[i]!.value !== v)) return false;
  const kids = p.children.filter((c) => !(c.kind === "text" && c.whitespace && !n.children.some((cid) => nodes.get(cid)?.text === c.text)));
  return kids.length === n.children.length && kids.every((c, i) => sameContent(c, n.children[i]!, nodes));
}
