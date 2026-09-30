import { describe, expect, it } from "vitest";
import { angleBetween, apply, applyLinear, anchorPoint, contains, invert, rectFromPoints, resizeScale, round, snap, type Mat } from "./geometry.js";

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe("matrices", () => {
  const m: Mat = { a: 2, b: 0.5, c: -1, d: 3, e: 10, f: -4 };
  it("inverts", () => {
    const p = { x: 3, y: 7 };
    const back = apply(invert(m), apply(m, p));
    close(back.x, 3);
    close(back.y, 7);
  });
  it("applies only the linear part to vectors", () => {
    expect(applyLinear({ a: 2, b: 0, c: 0, d: 2, e: 100, f: 100 }, { x: 1, y: 1 })).toEqual({ x: 2, y: 2 });
  });
  it("refuses singular matrices", () => {
    expect(() => invert({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toThrow();
  });
});

describe("resizeScale", () => {
  const box = { x: 0, y: 0, width: 100, height: 50 };
  it("scales both axes from a corner around the opposite corner", () => {
    expect(anchorPoint(box, "se")).toEqual({ x: 0, y: 0 });
    expect(resizeScale(box, "se", { x: 200, y: 25 })).toEqual([2, 0.5]);
    expect(anchorPoint(box, "nw")).toEqual({ x: 100, y: 50 });
    expect(resizeScale(box, "nw", { x: 50, y: 0 })).toEqual([0.5, 1]);
  });
  it("edge handles scale one axis", () => {
    expect(resizeScale(box, "e", { x: 150, y: 999 })).toEqual([1.5, 1]);
    expect(resizeScale(box, "n", { x: 999, y: -50 })).toEqual([1, 2]);
  });
  it("keeps aspect with the dominant factor", () => {
    expect(resizeScale(box, "se", { x: 300, y: 60 }, true)).toEqual([3, 3]);
  });
  it("never returns zero and flips past the anchor", () => {
    const [sx] = resizeScale(box, "e", { x: 0, y: 0 });
    expect(sx).not.toBe(0);
    expect(resizeScale(box, "e", { x: -100, y: 0 })[0]).toBe(-1);
  });
});

describe("helpers", () => {
  it("angleBetween is clockwise in screen space and wraps", () => {
    close(angleBetween({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }), 90);
    expect(angleBetween({ x: 0, y: 0 }, { x: -1, y: 0.001 }, { x: -1, y: -0.001 })).toBeCloseTo(0.1146, 3);
  });
  it("rectFromPoints normalizes and squares", () => {
    expect(rectFromPoints({ x: 10, y: 10 }, { x: 0, y: 4 })).toEqual({ x: 0, y: 4, width: 10, height: 6 });
    expect(rectFromPoints({ x: 0, y: 0 }, { x: 10, y: -4 }, true)).toEqual({ x: 0, y: -10, width: 10, height: 10 });
  });
  it("contains, snap, round", () => {
    expect(contains({ x: 0, y: 0, width: 10, height: 10 }, { x: 1, y: 1, width: 2, height: 2 })).toBe(true);
    expect(contains({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 1, width: 2, height: 2 })).toBe(false);
    expect(snap(22, 15)).toBe(15);
    expect(round(1.23456)).toBe(1.23);
    expect(Object.is(round(-0.001), 0)).toBe(true);
  });
});

describe("zoom and grid", () => {
  it("niceStep picks 1/2/5 x 10^n", async () => {
    const { niceStep } = await import("./geometry.js");
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.2)).toBe(2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(6)).toBe(10);
    expect(niceStep(0.03)).toBeCloseTo(0.05);
  });
  it("steps through zoom levels and fits content", async () => {
    const { nextZoom, fitZoom, snapPoint } = await import("./geometry.js");
    expect(nextZoom(1, 1)).toBe(1.5);
    expect(nextZoom(1, -1)).toBe(0.75);
    expect(nextZoom(1.2, -1)).toBe(1);
    expect(nextZoom(32, 1)).toBe(32);
    expect(fitZoom({ width: 24, height: 24 }, { width: 500, height: 300 })).toBeCloseTo(252 / 24);
    expect(snapPoint({ x: 12, y: 17 }, 5)).toEqual({ x: 10, y: 15 });
  });
});
