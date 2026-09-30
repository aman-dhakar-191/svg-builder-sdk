import { describe, expect, it } from "vitest";
import { numberAt, scrubbed } from "./scrub.js";

/** The number text at the "|" marker, or null. */
function at(marked: string): string | null {
  const pos = marked.indexOf("|");
  const text = marked.slice(0, pos) + marked.slice(pos + 1);
  const n = numberAt(text, pos);
  return n ? text.slice(n.from, n.to) : null;
}

describe("numberAt", () => {
  it("finds numbers in attribute values, including path data, transforms and units", () => {
    expect(at('<rect width="8|0"/>')).toBe("80");
    expect(at('<rect width="|80"/>')).toBe("80");
    expect(at('<rect width="80|"/>')).toBe("80");
    expect(at('<path d="M1|0 10 L-5.5 3"/>')).toBe("10");
    expect(at('<path d="M10 10 L-5.|5 3"/>')).toBe("-5.5");
    expect(at('<path d="M10-|5"/>')).toBe("-5"); // compact path data
    expect(at('<g transform="translate(1|2, 4)"/>')).toBe("12");
    expect(at("<text font-size='1|4px'/>")).toBe("14");
    expect(at('<circle style="stroke-width: 2|.5"/>')).toBe("2.5");
  });

  it("ignores ids, colours, names and text content", () => {
    expect(at('<rect id="shape|2"/>')).toBeNull();
    expect(at('<rect fill="#ff00|33"/>')).toBeNull();
    expect(at('<rect fill="#12|3456"/>')).toBeNull();
    expect(at('<rect class="col-|2"/>')).toBeNull();
    expect(at("<text>Chapter 1|2</text>")).toBeNull();
    expect(at('<rect x="1" y="2"| width="3"/>')).toBeNull(); // between attributes
    expect(at('<h|1/>')).toBeNull();
  });

  it("keeps the original's precision", () => {
    const text = '<rect width="1.50"/>';
    expect(numberAt(text, text.indexOf("1.5"))).toMatchObject({ value: 1.5, decimals: 2 });
  });
});

describe("scrubbed", () => {
  const n = (value: number, decimals: number) => ({ from: 0, to: 0, value, decimals });
  it("steps by the number's own precision, x10 when coarse", () => {
    expect(scrubbed(n(80, 0), 5)).toBe("85");
    expect(scrubbed(n(80, 0), -3, true)).toBe("50");
    expect(scrubbed(n(1.5, 1), 2)).toBe("1.7");
    expect(scrubbed(n(0.25, 2), -30)).toBe("-0.05");
    expect(scrubbed(n(0.1, 1), -1)).toBe("0.0");
    expect(scrubbed(n(1, 0), -1)).toBe("0");
  });
});
