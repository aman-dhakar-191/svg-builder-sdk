import { beforeEach, describe, expect, it } from "vitest";
import { createDocument, parseClock, readAnimation, timelineEnd, type SvgDocument } from "../src/index.js";
import { expectNoChange, expectRoundTrip, ok } from "./helpers.js";

let doc: SvgDocument;
const add = (tag: string, attrs: Record<string, string>, parent?: string) =>
  ok(doc.execute({ op: "add", tag, attrs, ...(parent ? { parent } : {}) })).id;
const kids = (id: string) => doc.getNode(id)!.children.map((c) => doc.getNode(c)!);

beforeEach(() => {
  doc = createDocument({ rootAttrs: { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 200 200" } });
});

describe("animate", () => {
  it("fades in to the element's own opacity, as one undo step", () => {
    const r = add("rect", { width: "40", height: "20", opacity: "0.5" });
    const res = expectRoundTrip(doc, { op: "animate", id: r, preset: "fadeIn" });
    expect(res.ids).toHaveLength(1);
    expect(kids(r)[0]).toMatchObject({
      tag: "animate",
      attrs: {
        attributeName: "opacity",
        values: "0;0.5",
        keyTimes: "0;1",
        calcMode: "spline",
        keySplines: "0 0 0.58 1",
        begin: "0s",
        dur: "0.6s",
        fill: "freeze",
        "data-motion": "fadeIn",
      },
    });
  });

  it("holds an entrance's first value through a load delay, so it is hidden from the start", () => {
    const r = add("rect", { width: "40", height: "20" });
    ok(doc.execute({ op: "animate", id: r, preset: "fadeIn", delay: 1, duration: 1, easing: "linear" }));
    const a = kids(r)[0]!.attrs;
    expect(a).toMatchObject({ values: "0;0;1", begin: "0s", dur: "2s" });
    // Evenly spaced and linear: no keyTimes or calcMode needed.
    expect(a.keyTimes).toBeUndefined();
    expect(a.calcMode).toBeUndefined();
    expect(readAnimation("animate", a)).toEqual({ preset: "fadeIn", attribute: "opacity", trigger: "load", delay: 1, duration: 1, repeat: 1 });
  });

  it("scales and rotates around the element's centre, after its own transform", () => {
    const c = add("circle", { cx: "50", cy: "30", r: "10", transform: "translate(5 5)" });
    ok(doc.execute({ op: "animate", id: c, preset: "popIn" }));
    expect(kids(c).map((k) => [k.attrs.type, k.attrs.values, k.attrs.additive])).toEqual([
      ["translate", "50 30;50 30;50 30", "sum"],
      ["scale", "0;1.1;1", "sum"],
      ["translate", "-50 -30;-50 -30;-50 -30", "sum"],
    ]);
    ok(doc.execute({ op: "animate", id: c, preset: "spin", clockwise: false }));
    const spin = kids(c).at(-1)!.attrs;
    expect(spin).toMatchObject({ type: "rotate", values: "0 50 30;-360 50 30", repeatCount: "indefinite", dur: "2s" });
    expect(spin.fill).toBeUndefined();
    expect(spin.calcMode).toBeUndefined();
  });

  it("uses a measured box for elements the model cannot measure", () => {
    const t = add("text", { x: "10", y: "20" });
    ok(doc.execute({ op: "setText", id: t, text: "Hi" }));
    expectNoChange(doc, { op: "animate", id: t, preset: "pulse" });
    ok(doc.execute({ op: "animate", id: t, preset: "pulse", box: { x: 10, y: 5, width: 20, height: 20 } }));
    expect(kids(t)[1]!.attrs.values).toBe("20 15;20 15;20 15");
    // Text stays editable with animation children.
    ok(doc.execute({ op: "setText", id: t, text: "Hello" }));
    expect(kids(t).map((k) => k.tag)).toEqual(["#text", "animateTransform", "animateTransform", "animateTransform"]);
    expect(kids(t)[0]!.text).toBe("Hello");
  });

  it("re-applying a preset replaces it; other presets stay", () => {
    const r = add("rect", { width: "40", height: "20" });
    ok(doc.execute({ op: "animate", id: r, preset: "fadeIn" }));
    ok(doc.execute({ op: "animate", id: r, preset: "slideIn", from: "left" }));
    ok(doc.execute({ op: "animate", id: r, preset: "fadeIn", duration: 2 }));
    expect(kids(r).map((k) => [k.attrs["data-motion"], k.attrs.dur])).toEqual([
      ["slideIn", "0.6s"],
      ["fadeIn", "2s"],
    ]);
    expect(kids(r)[0]!.attrs.values).toBe("-20 0;0 0");
  });

  it("draws a stroke on with pathLength and brings the fill in at the end", () => {
    const p = add("path", { d: "M0 0 L100 0", stroke: "red" });
    ok(doc.execute({ op: "animate", id: p, preset: "drawOn" }));
    expect(doc.getNode(p)!.attrs.pathLength).toBe("1");
    expect(kids(p).map((k) => k.attrs.attributeName)).toEqual(["stroke-dasharray", "stroke-dashoffset", "fill-opacity"]);
    ok(doc.execute({ op: "removeAnimations", id: p, preset: "drawOn" }));
    expect(doc.getNode(p)!.attrs.pathLength).toBeUndefined();
    expect(kids(p)).toHaveLength(0);

    // Inherited stroke counts; fill="none" means no fill fade.
    const g = add("g", { style: "stroke: blue" });
    const l = add("polyline", { points: "0,0 10,10", fill: "none" }, g);
    ok(doc.execute({ op: "animate", id: l, preset: "drawOn", trigger: "click", delay: 0.5 }));
    expect(kids(l).map((k) => k.attrs.begin)).toEqual(["click+0.5s", "click+0.5s"]);
  });

  it("refuses what it cannot do, without changing anything", () => {
    const r = add("rect", { width: "4", height: "4" });
    const dashed = add("path", { d: "M0 0 L9 9", stroke: "red", "stroke-dasharray": "2 2" });
    const g = add("g", {});
    expect(expectNoChange(doc, { op: "animate", id: r, preset: "drawOn" }).code).toBe("NOT_ANIMATABLE");
    expect(expectNoChange(doc, { op: "animate", id: dashed, preset: "drawOn" }).code).toBe("NOT_ANIMATABLE");
    expect(expectNoChange(doc, { op: "animate", id: g, preset: "drawOn" }).code).toBe("NOT_ANIMATABLE");
    expect(expectNoChange(doc, { op: "animate", id: g, preset: "spin" }).code).toBe("BBOX_UNAVAILABLE");
    expect(expectNoChange(doc, { op: "animate", id: r, preset: "explode" }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "animate", id: r, preset: "fadeIn", duration: 0 }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "animate", id: r, preset: "fadeIn", durration: 1 }).code).toBe("INVALID_COMMAND");
    expect(expectNoChange(doc, { op: "animate", id: doc.root, preset: "fadeIn" }).code).toBe("ROOT_NOT_ALLOWED");
  });

  it("loops on hover stop when the pointer leaves", () => {
    const r = add("rect", { width: "40", height: "20" });
    ok(doc.execute({ op: "animate", id: r, preset: "float", trigger: "hover", repeat: 3 }));
    expect(kids(r)[0]!.attrs).toMatchObject({ begin: "mouseover", end: "mouseout", repeatCount: "3", values: "0 0;0 -2;0 0" });
  });
});

describe("removeAnimations", () => {
  it("removes all animations, hand-written ones too", () => {
    const r = add("rect", { width: "40", height: "20" });
    add("animate", { attributeName: "x", from: "0", to: "10", dur: "1s" }, r);
    ok(doc.execute({ op: "animate", id: r, preset: "wiggle" }));
    const res = expectRoundTrip(doc, { op: "removeAnimations", id: r });
    expect(res.removed).toBe(2);
    expect(kids(r)).toHaveLength(0);
  });
});

describe("static output", () => {
  it("leaves animations out of toSvg({ static: true })", () => {
    const g = add("g", {});
    const r = add("rect", { width: "40", height: "20" }, g);
    ok(doc.execute({ op: "animate", id: r, preset: "fadeIn" }));
    expect(doc.toSvg()).toContain("<animate ");
    expect(doc.toSvg({ static: true, pretty: true })).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">\n  <g>\n    <rect width="40" height="20"/>\n  </g>\n</svg>',
    );
  });
});

describe("timing", () => {
  it("parses clock values", () => {
    expect(["2s", "500ms", "1.5", "1min", "00:01.5", "01:00:00", "click", undefined].map(parseClock)).toEqual([2, 0.5, 1.5, 60, 1.5, 3600, null, null]);
  });

  it("ends the timeline when the last load animation finishes one pass", () => {
    const r = add("rect", { width: "40", height: "20" });
    ok(doc.execute({ op: "animate", id: r, preset: "fadeIn", delay: 0.4 }));
    ok(doc.execute({ op: "animate", id: r, preset: "spin", delay: 0.5 }));
    ok(doc.execute({ op: "animate", id: r, preset: "pulse", trigger: "click", duration: 9 }));
    const infos = kids(r).map((k) => readAnimation(k.tag, k.attrs));
    expect(timelineEnd(infos)).toBe(2.5);
    expect(timelineEnd([])).toBe(0);
  });
});
