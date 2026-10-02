import { beforeEach, describe, expect, it } from "vitest";
import { createDocument, readTracks, readAnimation, timelineEnd, valueAt, type SvgDocument } from "../src/index.js";
import { expectNoChange, expectRoundTrip, ok } from "./helpers.js";

let doc: SvgDocument;
const add = (tag: string, attrs: Record<string, string>) => ok(doc.execute({ op: "add", tag, attrs })).id;
const kids = (id: string) => doc.getNode(id)!.children.map((c) => doc.getNode(c)!);
const tracks = (id: string) => readTracks(kids(id));

beforeEach(() => {
  doc = createDocument({ rootAttrs: { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 200 100" } });
});

describe("keyframes", () => {
  it("stores a track as SMIL, held from 0 until the first key, one undo step", () => {
    const r = add("rect", { x: "0", y: "0", width: "20", height: "10" });
    expectRoundTrip(doc, { op: "keyframes", id: r, property: "opacity", keys: [{ time: 2, value: 0 }, { time: 0.5, value: 1 }] });
    expect(kids(r)[0]!.attrs).toEqual({
      attributeName: "opacity",
      values: "1;1;0",
      keyTimes: "0;0.25;1",
      calcMode: "spline",
      keySplines: "0 0 1 1;0.42 0 0.58 1",
      begin: "0s",
      dur: "2s",
      fill: "freeze",
      "data-motion": "keys",
      "data-key": "opacity",
      "data-keys": "0.5;2",
      "data-ease": "easeInOut",
    });
    expect(tracks(r)).toEqual([{ property: "opacity", easing: "easeInOut", keys: [{ time: 0.5, value: 1 }, { time: 2, value: 0 }], ids: [kids(r)[0]!.id] }]);
    // On the timeline: it ends with its last key.
    expect(timelineEnd(kids(r).map((k) => readAnimation(k.tag, k.attrs)))).toBe(2);
  });

  it("rotates and scales about the element's centre, keeping transform tracks in order", () => {
    const r = add("rect", { x: "10", y: "10", width: "20", height: "10" });
    ok(doc.execute({ op: "keyframes", id: r, property: "scale", keys: [{ time: 0, value: 1 }, { time: 1, value: [2, 1.5] }], easing: "linear" }));
    ok(doc.execute({ op: "keyframes", id: r, property: "rotate", keys: [{ time: 0, value: 0 }, { time: 1, value: 90 }] }));
    ok(doc.execute({ op: "keyframes", id: r, property: "translate", keys: [{ time: 1, value: [30, 0] }] }));
    expect(kids(r).map((k) => [k.attrs["data-key"], k.attrs.type])).toEqual([
      ["translate", "translate"],
      ["rotate", "rotate"],
      ["scale-origin", "translate"],
      ["scale", "scale"],
      ["scale-origin", "translate"],
    ]);
    expect(kids(r)[1]!.attrs.values).toBe("0 20 15;90 20 15");
    expect(kids(r)[2]!.attrs.values).toBe("20 15;20 15");
    expect(kids(r)[3]!.attrs).toMatchObject({ values: "1 1;2 1.5", additive: "sum" });
    expect(kids(r)[3]!.attrs.calcMode).toBeUndefined();
    // Changing rotation later keeps its centre even after the shape moved.
    ok(doc.execute({ op: "set", id: r, attrs: { x: "100" } }));
    ok(doc.execute({ op: "keyframes", id: r, property: "rotate", keys: [{ time: 0, value: 0 }, { time: 2, value: 180 }] }));
    expect(kids(r).find((k) => k.attrs["data-key"] === "rotate")!.attrs.values).toBe("0 20 15;180 20 15");
    expect(tracks(r).map((t) => t.property)).toEqual(["translate", "rotate", "scale"]);
    expect(tracks(r).find((t) => t.property === "scale")!.ids).toHaveLength(3);
    // Removing a track removes all its elements.
    ok(doc.execute({ op: "keyframes", id: r, property: "scale", keys: [] }));
    expect(kids(r).map((k) => k.attrs["data-key"])).toEqual(["translate", "rotate"]);
  });

  it("colours step between keys; values are interpolated with the easing", () => {
    const t = { property: "translate" as const, easing: "linear" as const, keys: [{ time: 0, value: [0, 0] as [number, number] }, { time: 2, value: [10, 20] as [number, number] }] };
    expect(valueAt(t, 1)).toEqual([5, 10]);
    expect(valueAt(t, -1)).toEqual([0, 0]);
    expect(valueAt(t, 9)).toEqual([10, 20]);
    const eased = valueAt({ ...t, easing: "easeIn" }, 1) as number[];
    expect(eased[0]).toBeLessThan(5);
    expect(valueAt({ property: "fill", easing: "linear", keys: [{ time: 0, value: "red" }, { time: 1, value: "blue" }] }, 0.5)).toBe("red");
  });

  it("refuses bad input without changing anything", () => {
    const r = add("rect", { width: "20", height: "10" });
    const g = add("g", {});
    expect(expectNoChange(doc, { op: "keyframes", id: r, property: "size", keys: [] }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "keyframes", id: r, property: "opacity", keys: [{ time: 0, value: 2 }] }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "keyframes", id: r, property: "translate", keys: [{ time: -1, value: [0, 0] }] }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "keyframes", id: r, property: "fill", keys: [{ time: 0, value: 'red"' }] }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "keyframes", id: g, property: "rotate", keys: [{ time: 0, value: 10 }] }).code).toBe("BBOX_UNAVAILABLE");
    expect(expectNoChange(doc, { op: "keyframes", id: doc.root, property: "opacity", keys: [] }).code).toBe("ROOT_NOT_ALLOWED");
  });

  it("removeAnimations with preset 'keys' removes all keyframes and keeps presets", () => {
    const r = add("rect", { width: "20", height: "10" });
    ok(doc.execute({ op: "animate", id: r, preset: "fadeIn" }));
    ok(doc.execute({ op: "keyframes", id: r, property: "fill", keys: [{ time: 0, value: "red" }, { time: 1, value: "blue" }] }));
    ok(doc.execute({ op: "removeAnimations", id: r, preset: "keys" }));
    expect(kids(r).map((k) => k.attrs["data-motion"])).toEqual(["fadeIn"]);
  });
});
