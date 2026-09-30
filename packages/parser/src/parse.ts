/**
 * Position-aware XML parser for SVG. Hand-written so every element, attribute
 * name, attribute value and text run has exact source offsets; those are what
 * make minimal text patches possible. Comments, processing instructions and
 * the DOCTYPE are skipped (they stay untouched in the source text).
 */

export interface ParsedAttr {
  name: string;
  /** Decoded value, with XML attribute-value whitespace normalization applied. */
  value: string;
  /** Offset of the name. */
  start: number;
  /** Offsets of the raw value, inside the quotes. */
  valueStart: number;
  valueEnd: number;
  /** Offset just past the closing quote. */
  end: number;
  quote: '"' | "'";
}

export interface ParsedElement {
  kind: "element";
  tag: string;
  attrs: ParsedAttr[];
  children: ParsedNode[];
  /** Offset of "<". */
  start: number;
  /** Offset just past the end tag's ">" (or "/>"). */
  end: number;
  /** Offset just past the tag name. */
  nameEnd: number;
  /** Offset just past the last attribute (or the name if none). */
  attrsEnd: number;
  /** Offset just past the start tag's ">" (equals `end` when self-closing). */
  openEnd: number;
  /** Offset of "</" (equals `end` when self-closing). */
  closeStart: number;
  selfClosing: boolean;
}

export interface ParsedText {
  kind: "text";
  /** Decoded text. Adjacent character data, entity references and CDATA are merged. */
  text: string;
  start: number;
  end: number;
  /** True when every piece was whitespace-only literal text (no CDATA, no references). */
  whitespace: boolean;
}

export type ParsedNode = ParsedElement | ParsedText;

export type ParseErrorCode =
  | "UNEXPECTED_EOF"
  | "UNEXPECTED_CHAR"
  | "MISMATCHED_TAG"
  | "DUPLICATE_ATTR"
  | "INVALID_ENTITY"
  | "UNKNOWN_ENTITY"
  | "NO_ROOT"
  | "NOT_SVG"
  | "TRAILING_CONTENT";

export interface ParseError {
  code: ParseErrorCode;
  message: string;
  hint: string;
  offset: number;
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 code units. */
  column: number;
}

export type ParseResult =
  | { ok: true; root: ParsedElement; entities: Map<string, string> }
  | { ok: false; error: ParseError };

class Failure extends Error {
  constructor(
    readonly code: ParseErrorCode,
    readonly offset: number,
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

const NAME = /[A-Za-z_:À-￿][\w.\-:·À-￿]*/y;
const WS = /[ \t\r\n]*/y;
const PREDEFINED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const MAX_EXPANSION = 1_000_000;

export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export function parseSvg(text: string): ParseResult {
  try {
    return new Parser(text).document();
  } catch (e) {
    if (!(e instanceof Failure)) throw e;
    return { ok: false, error: { code: e.code, message: e.message, hint: e.hint, offset: e.offset, ...lineColumn(text, e.offset) } };
  }
}

class Parser {
  private i = 0;
  private readonly entities = new Map<string, string>();
  private expanded = 0;

  constructor(private readonly src: string) {
    if (src.charCodeAt(0) === 0xfeff) this.i = 1;
  }

  document(): ParseResult {
    let root: ParsedElement | undefined;
    for (;;) {
      this.skipWs();
      if (this.i >= this.src.length) break;
      if (this.at("<?")) this.skipPast("?>", "processing instruction");
      else if (this.at("<!--")) this.skipPast("-->", "comment");
      else if (this.at("<!DOCTYPE")) {
        if (root) this.fail("TRAILING_CONTENT", "DOCTYPE after the root element.", "Move the DOCTYPE before <svg>.");
        this.doctype();
      } else if (this.at("<")) {
        if (root) this.fail("TRAILING_CONTENT", "Content after the root element.", "An SVG file has exactly one root <svg> element; wrap siblings in it.");
        root = this.element();
      } else {
        this.fail(root ? "TRAILING_CONTENT" : "UNEXPECTED_CHAR", "Text outside the root element.", "Only comments and whitespace may appear outside <svg>.");
      }
    }
    if (!root) this.fail("NO_ROOT", "No root element found.", "The file must contain an <svg> element.", 0);
    if (root.tag !== "svg") this.fail("NOT_SVG", `Root element is <${root.tag}>, not <svg>.`, "Wrap the content in <svg xmlns=\"http://www.w3.org/2000/svg\">.", root.start);
    return { ok: true, root, entities: this.entities };
  }

  // ------------------------------------------------------------ primitives

  private fail(code: ParseErrorCode, message: string, hint: string, offset = this.i): never {
    throw new Failure(code, offset, message, hint);
  }

  private at(s: string): boolean {
    return this.src.startsWith(s, this.i);
  }

  private skipWs(): number {
    WS.lastIndex = this.i;
    WS.exec(this.src);
    const n = WS.lastIndex - this.i;
    this.i = WS.lastIndex;
    return n;
  }

  private skipPast(end: string, what: string): void {
    const j = this.src.indexOf(end, this.i);
    if (j < 0) this.fail("UNEXPECTED_EOF", `Unterminated ${what}.`, `Close it with "${end}".`);
    this.i = j + end.length;
  }

  private name(what: string): string {
    NAME.lastIndex = this.i;
    const m = NAME.exec(this.src);
    if (!m) {
      if (this.i >= this.src.length) this.fail("UNEXPECTED_EOF", `Expected ${what}, reached end of file.`, "The file looks truncated.");
      this.fail("UNEXPECTED_CHAR", `Expected ${what}, found ${JSON.stringify(this.src[this.i])}.`, "Names start with a letter, '_' or ':'.");
    }
    this.i = NAME.lastIndex;
    return m[0];
  }

  private expect(s: string, hint: string): void {
    if (!this.at(s)) {
      if (this.i >= this.src.length) this.fail("UNEXPECTED_EOF", `Expected "${s}", reached end of file.`, hint);
      this.fail("UNEXPECTED_CHAR", `Expected "${s}", found ${JSON.stringify(this.src[this.i])}.`, hint);
    }
    this.i += s.length;
  }

  // -------------------------------------------------------------- doctype

  private doctype(): void {
    const start = this.i;
    this.i += "<!DOCTYPE".length;
    let quote: string | null = null;
    let subsetStart = -1;
    for (; this.i < this.src.length; this.i++) {
      const ch = this.src[this.i]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (subsetStart >= 0) {
        if (ch === "]") {
          this.internalSubset(this.src.slice(subsetStart, this.i), subsetStart);
          subsetStart = -1;
        }
      } else if (ch === "[") {
        subsetStart = this.i + 1;
      } else if (ch === ">") {
        this.i++;
        return;
      }
    }
    this.fail("UNEXPECTED_EOF", "Unterminated DOCTYPE.", 'Close it with ">".', start);
  }

  private internalSubset(subset: string, offset: number): void {
    // Only internal general entities with literal values (what Illustrator writes).
    const re = /<!ENTITY\s+([^\s%]+)\s+(["'])([\s\S]*?)\2\s*>/g;
    for (let m = re.exec(subset); m; m = re.exec(subset)) {
      const name = m[1]!;
      if (!this.entities.has(name)) this.entities.set(name, this.decode(m[3]!, offset + m.index, 0));
    }
  }

  // -------------------------------------------------------------- entities

  private decode(raw: string, offset: number, depth: number): string {
    if (!raw.includes("&")) return raw;
    return raw.replace(/&([^;&\s<]*);?/g, (whole, ref: string, at: number) => {
      const pos = offset + at;
      if (!whole.endsWith(";") || ref === "") {
        this.fail("INVALID_ENTITY", "Bare '&' in text or attribute value.", 'Write "&amp;" for a literal ampersand.', pos);
      }
      let out: string | undefined;
      if (ref.startsWith("#x") || ref.startsWith("#X")) out = codePoint(parseInt(ref.slice(2), 16), /^[0-9a-fA-F]+$/.test(ref.slice(2)));
      else if (ref.startsWith("#")) out = codePoint(parseInt(ref.slice(1), 10), /^[0-9]+$/.test(ref.slice(1)));
      else if (ref in PREDEFINED) out = PREDEFINED[ref];
      else if (this.entities.has(ref)) {
        if (depth > 8) this.fail("INVALID_ENTITY", `Entity "&${ref};" nests too deeply.`, "Entities may reference each other at most 8 levels deep.", pos);
        out = this.decode(this.entities.get(ref)!, pos, depth + 1);
        this.expanded += out.length;
        if (this.expanded > MAX_EXPANSION) this.fail("INVALID_ENTITY", "Entity expansion is too large.", "This looks like an entity-expansion attack; the file is rejected.", pos);
      } else {
        this.fail("UNKNOWN_ENTITY", `Unknown entity "&${ref};".`, "Only the five XML entities, numeric references and entities declared in the DOCTYPE are allowed.", pos);
      }
      if (out === undefined) this.fail("INVALID_ENTITY", `Invalid character reference "&${ref};".`, "Use a valid Unicode code point.", pos);
      return out;
    });
  }

  // -------------------------------------------------------------- elements

  private element(): ParsedElement {
    const start = this.i;
    this.i++; // "<"
    const tag = this.name("an element name");
    const nameEnd = this.i;
    const attrs: ParsedAttr[] = [];
    let attrsEnd = nameEnd;
    for (;;) {
      const ws = this.skipWs();
      if (this.at("/>")) {
        this.i += 2;
        return { kind: "element", tag, attrs, children: [], start, end: this.i, nameEnd, attrsEnd, openEnd: this.i, closeStart: this.i, selfClosing: true };
      }
      if (this.at(">")) {
        this.i++;
        break;
      }
      if (ws === 0) {
        if (this.i >= this.src.length) this.fail("UNEXPECTED_EOF", `Unterminated <${tag}> start tag.`, 'Close it with ">" or "/>".', start);
        this.fail("UNEXPECTED_CHAR", `Expected whitespace, ">" or "/>" in <${tag}>, found ${JSON.stringify(this.src[this.i])}.`, "Separate attributes with whitespace.");
      }
      const attr = this.attribute(tag);
      if (attrs.some((a) => a.name === attr.name)) {
        this.fail("DUPLICATE_ATTR", `Attribute "${attr.name}" appears twice on <${tag}>.`, "Remove one of them.", attr.start);
      }
      attrs.push(attr);
      attrsEnd = this.i;
    }
    const openEnd = this.i;
    const children = this.content(tag, start);
    const closeStart = this.i;
    this.i += 2; // "</"
    const closeName = this.name("a closing tag name");
    if (closeName !== tag) {
      this.fail("MISMATCHED_TAG", `Closing tag </${closeName}> does not match <${tag}>.`, `Close <${tag}> (opened at offset ${start}) first.`, closeStart);
    }
    this.skipWs();
    this.expect(">", `Close the </${tag}> tag with ">".`);
    return { kind: "element", tag, attrs, children, start, end: this.i, nameEnd, attrsEnd, openEnd, closeStart, selfClosing: false };
  }

  private attribute(tag: string): ParsedAttr {
    const start = this.i;
    const name = this.name("an attribute name");
    this.skipWs();
    this.expect("=", `Attribute "${name}" on <${tag}> needs a value, e.g. ${name}="...".`);
    this.skipWs();
    const quote = this.src[this.i];
    if (quote !== '"' && quote !== "'") {
      this.fail("UNEXPECTED_CHAR", `Value of "${name}" must be quoted.`, `Write ${name}="value".`);
    }
    const valueStart = this.i + 1;
    const valueEnd = this.src.indexOf(quote, valueStart);
    if (valueEnd < 0) this.fail("UNEXPECTED_EOF", `Unterminated value for "${name}".`, `Close it with ${quote}.`, valueStart);
    const raw = this.src.slice(valueStart, valueEnd);
    const lt = raw.indexOf("<");
    if (lt >= 0) this.fail("UNEXPECTED_CHAR", `"<" is not allowed in the value of "${name}".`, 'Write "&lt;" instead.', valueStart + lt);
    const value = this.decode(raw.replace(/\r\n|[\t\n\r]/g, " "), valueStart, 0);
    this.i = valueEnd + 1;
    return { name, value, start, valueStart, valueEnd, end: this.i, quote };
  }

  private content(tag: string, openStart: number): ParsedNode[] {
    const children: ParsedNode[] = [];
    let text: ParsedText | null = null;
    const addText = (s: string, start: number, end: number, literalWs: boolean) => {
      if (text) {
        text.text += s;
        text.end = end;
        text.whitespace &&= literalWs;
      } else {
        text = { kind: "text", text: s, start, end, whitespace: literalWs };
        children.push(text);
      }
    };
    for (;;) {
      if (this.i >= this.src.length) {
        this.fail("UNEXPECTED_EOF", `<${tag}> is never closed.`, `Add </${tag}>.`, openStart);
      }
      if (this.at("</")) return children;
      if (this.at("<!--")) {
        this.skipPast("-->", "comment");
        text = null;
      } else if (this.at("<![CDATA[")) {
        const start = this.i;
        const end = this.src.indexOf("]]>", start);
        if (end < 0) this.fail("UNEXPECTED_EOF", "Unterminated CDATA section.", 'Close it with "]]>".');
        this.i = end + 3;
        addText(this.src.slice(start + 9, end).replace(/\r\n?/g, "\n"), start, this.i, false);
      } else if (this.at("<?")) {
        this.skipPast("?>", "processing instruction");
        text = null;
      } else if (this.at("<!")) {
        this.fail("UNEXPECTED_CHAR", 'Unexpected "<!" inside an element.', "Only comments and CDATA sections start with <! here.");
      } else if (this.at("<")) {
        children.push(this.element());
        text = null;
      } else {
        const start = this.i;
        let end = this.src.indexOf("<", start);
        if (end < 0) end = this.src.length;
        const raw = this.src.slice(start, end);
        this.i = end;
        addText(this.decode(raw.replace(/\r\n?/g, "\n"), start, 0), start, end, /^[ \t\r\n]*$/.test(raw));
      }
    }
  }
}

function codePoint(n: number, valid: boolean): string | undefined {
  if (!valid || !Number.isFinite(n) || n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return undefined;
  return String.fromCodePoint(n);
}
