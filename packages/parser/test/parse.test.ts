import { describe, expect, it } from "vitest";
import { parseSvg, type ParsedElement, type ParsedText } from "../src/index.js";

function root(src: string): ParsedElement {
  const r = parseSvg(src);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.root;
}

describe("parseSvg offsets", () => {
  const src = `<svg a = 'x' b="&amp;y"><rect/><g>t&lt;u<![CDATA[<v>]]></g></svg>`;
  const r = root(src);

  it("records element ranges", () => {
    expect(src.slice(r.start, r.end)).toBe(src);
    expect(src.slice(r.start, r.openEnd)).toBe(`<svg a = 'x' b="&amp;y">`);
    expect(src.slice(r.closeStart, r.end)).toBe("</svg>");
    expect(src.slice(r.nameEnd, r.attrsEnd)).toBe(` a = 'x' b="&amp;y"`);
    const rect = r.children[0] as ParsedElement;
    expect(rect.selfClosing).toBe(true);
    expect(src.slice(rect.start, rect.end)).toBe("<rect/>");
  });

  it("records attribute name and raw value ranges, decoded values and quotes", () => {
    const [a, b] = r.attrs;
    expect(src.slice(a!.start, a!.end)).toBe("a = 'x'");
    expect(a!.quote).toBe("'");
    expect(src.slice(b!.valueStart, b!.valueEnd)).toBe("&amp;y");
    expect(b!.value).toBe("&y");
  });

  it("merges text, references and CDATA into one text node", () => {
    const t = (r.children[1] as ParsedElement).children[0] as ParsedText;
    expect(t.text).toBe("t<u<v>");
    expect(src.slice(t.start, t.end)).toBe("t&lt;u<![CDATA[<v>]]>");
    expect(t.whitespace).toBe(false);
  });
});

describe("parseSvg XML details", () => {
  it("expands DOCTYPE entities and normalizes attribute whitespace and CRLF text", () => {
    const r = root(`<!DOCTYPE svg [\n <!ENTITY ns "http://www.w3.org/2000/svg">\n]>\r\n<svg xmlns="&ns;" d="a\r\nb\tc&#10;"><text>x\r\ny</text></svg>`);
    expect(r.attrs[0]!.value).toBe("http://www.w3.org/2000/svg");
    expect(r.attrs[1]!.value).toBe("a b c\n");
    expect(((r.children[0] as ParsedElement).children[0] as ParsedText).text).toBe("x\ny");
  });

  it("skips BOM, XML declaration, comments and PIs", () => {
    const r = root(`﻿<?xml version="1.0"?><!-- a --><?pi x?><svg><!-- b --><g/></svg><!-- c -->`);
    expect(r.children.map((c) => c.kind === "element" && c.tag)).toEqual(["g"]);
  });

  it("splits text around comments", () => {
    const r = root(`<svg><text>a<!-- c -->b</text></svg>`);
    expect((r.children[0] as ParsedElement).children.map((c) => (c as ParsedText).text)).toEqual(["a", "b"]);
  });
});

describe("parseSvg errors", () => {
  const cases: [string, string, number, number][] = [
    ["<svg><g></svg>", "MISMATCHED_TAG", 1, 9],
    ["<svg>\n  <rect x=1/>\n</svg>", "UNEXPECTED_CHAR", 2, 11],
    ['<svg a="1" a="2"/>', "DUPLICATE_ATTR", 1, 12],
    ["<svg><text>a & b</text></svg>", "INVALID_ENTITY", 1, 14],
    ["<svg><text>&nbsp;</text></svg>", "UNKNOWN_ENTITY", 1, 12],
    ["<svg><g>", "UNEXPECTED_EOF", 1, 6],
    ["<html/>", "NOT_SVG", 1, 1],
    ["<svg/><svg/>", "TRAILING_CONTENT", 1, 7],
    ["   ", "NO_ROOT", 1, 1],
    ['<svg a="<"/>', "UNEXPECTED_CHAR", 1, 9],
  ];
  it.each(cases)("%j -> %s at %i:%i", (src, code, line, column) => {
    const r = parseSvg(src);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code, line, column });
    expect(r.error.hint.length).toBeGreaterThan(0);
  });

  it("rejects runaway entity expansion", () => {
    const decl = ['<!ENTITY a "aaaaaaaaaa">'];
    for (let i = 1; i < 8; i++) decl.push(`<!ENTITY ${"b".repeat(i)} "${`&${i === 1 ? "a" : "b".repeat(i - 1)};`.repeat(10)}">`);
    const r = parseSvg(`<!DOCTYPE svg [${decl.join("")}]><svg><text>&bbbbbbb;&bbbbbbb;</text></svg>`);
    expect(!r.ok && r.error.code).toBe("INVALID_ENTITY");
  });
});
