/**
 * Finding and changing a number in SVG markup for drag-to-scrub in the code pane.
 * Only numbers inside attribute values count: not ids ("shape2"), colours ("#ff0033") or text content.
 */

export interface ScrubNumber {
  /** Offsets of the number's characters (sign included, unit excluded). */
  from: number;
  to: number;
  value: number;
  /** Decimal places of the original, kept while scrubbing. */
  decimals: number;
}

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const PATH_COMMANDS = /[MmLlHhVvCcSsQqTtAaZz]/;

/** The attribute value around `pos`: its name and where its text starts and ends, if `pos` is inside one. */
function attributeAt(text: string, pos: number): { name: string; start: number; end: number } | null {
  // Walk back to the quote that opens the value (not past the tag's "<").
  for (let i = pos - 1; i >= 0; i--) {
    const c = text[i]!;
    if (c === "<" || c === ">") return null;
    if (c !== '"' && c !== "'") continue;
    // A value's opening quote follows "name=" (spaces allowed around "=").
    let j = i - 1;
    while (j >= 0 && /\s/.test(text[j]!)) j--;
    if (text[j] !== "=") return null; // a closing quote: pos is between attributes
    j--;
    while (j >= 0 && /\s/.test(text[j]!)) j--;
    let k = j;
    while (k >= 0 && /[\w:.-]/.test(text[k]!)) k--;
    const name = text.slice(k + 1, j + 1);
    const end = text.indexOf(c, i + 1);
    if (!name || end < 0 || end < pos) return null;
    return { name, start: i + 1, end };
  }
  return null;
}

/** The number at offset `pos` (inside or touching it), when it is part of an attribute value. */
export function numberAt(text: string, pos: number): ScrubNumber | null {
  const attr = attributeAt(text, pos);
  if (!attr) return null;
  const value = text.slice(attr.start, attr.end);
  for (const m of value.matchAll(NUMBER)) {
    const from = attr.start + m.index;
    const to = from + m[0].length;
    if (pos < from || pos > to) continue;
    const before = m.index > 0 ? value[m.index - 1]! : "";
    // A letter or "#" right before: part of a word (an id, a colour), unless it is a path command in d.
    // (A digit is fine: compact path data like "M10-5" has "-5" right after "10".)
    if (/[#_A-Za-z]/.test(before) && !(attr.name === "d" && PATH_COMMANDS.test(before))) return null;
    // "_" right after: also part of a word ("n_12" is caught above; "2_b" here).
    const after = value[m.index + m[0].length] ?? "";
    if (after === "_") return null;
    const literal = m[0];
    const dot = literal.replace(/[eE].*$/, "").indexOf(".");
    const decimals = dot < 0 ? 0 : literal.replace(/[eE].*$/, "").length - dot - 1;
    return { from, to, value: Number(literal), decimals };
  }
  return null;
}

/** The scrubbed value's text: `steps` of the number's own precision (x10 with `coarse`). */
export function scrubbed(n: ScrubNumber, steps: number, coarse = false): string {
  const step = 10 ** -n.decimals * (coarse ? 10 : 1);
  const v = n.value + steps * step;
  const s = v.toFixed(n.decimals);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}
