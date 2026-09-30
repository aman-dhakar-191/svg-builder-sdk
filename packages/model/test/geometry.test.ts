import { describe, expect, it } from "vitest";
import { applyToPoint, formatNumber, parseTransform, parseTransformList } from "../src/geometry.js";

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9));

describe("parseTransformList", () => {
  it("accepts SVG's comma/whitespace variants", () => {
    const ops = parseTransformList(" translate(10,20)rotate( 45 1 2 ) , scale(2)matrix(1 0 0 1 -1e1 .5) ");
    expect(ops?.map((o) => [o.name, o.args])).toEqual([
      ["translate", [10, 20]],
      ["rotate", [45, 1, 2]],
      ["scale", [2]],
      ["matrix", [1, 0, 0, 1, -10, 0.5]],
    ]);
    expect(parseTransformList("translate(10-5)")?.[0]?.args).toEqual([10, -5]);
    expect(parseTransformList("")).toEqual([]);
  });

  it("rejects invalid lists", () => {
    for (const bad of ["translate(1,)", "rotate(1 2)", "foo(1)", "translate(1", "scale()", "translate 1"]) {
      expect(parseTransformList(bad), bad).toBeNull();
    }
  });
});

describe("parseTransform", () => {
  it("composes left to right like SVG", () => {
    const m = parseTransform("translate(10 0) rotate(90)")!;
    close(applyToPoint(m, [1, 0]), [10, 1]);
    const r = parseTransform("rotate(90 5 5)")!;
    close(applyToPoint(r, [5, 5]), [5, 5]);
    close(applyToPoint(r, [6, 5]), [5, 6]);
    close(applyToPoint(parseTransform("scale(2 3)")!, [1, 1]), [2, 3]);
    close(applyToPoint(parseTransform(undefined)!, [4, 4]), [4, 4]);
  });
});

describe("formatNumber", () => {
  it("trims float noise and negative zero", () => {
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber(-1e-9)).toBe("0");
    expect(formatNumber(12.5)).toBe("12.5");
  });
});
