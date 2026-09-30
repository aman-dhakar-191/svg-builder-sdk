import { describe, expect, it } from "vitest";
import { createEditor } from "../src/index.js";
import { buildBarChart } from "../examples/bar-chart.js";

describe("headless example: bar chart from scratch", () => {
  const data = [
    { label: "A", value: 10 },
    { label: "B", value: 30 },
    { label: "C", value: 20 },
  ];

  it("builds a valid SVG that re-opens identically", () => {
    const ed = buildBarChart("Test", data);
    const svg = ed.toSvg({ pretty: true });
    const again = createEditor({ svg });
    expect(again.doc.query({ tag: "rect", attr: { "data-label": true } })).toHaveLength(3);
    expect(svg).toContain(">Test</text>");
    expect(again.toSvg()).toBe(ed.toSvg());
  });

  it("scales bars to the data and highlights the tallest", () => {
    const ed = buildBarChart("Test", data);
    const bars = ed.doc.query({ tag: "rect", attr: { "data-label": true } }).map((id) => ed.doc.getNode(id).attrs);
    const heights = bars.map((b) => Number(b.height));
    expect(heights[1]).toBeCloseTo(220);
    expect(heights[0]! / heights[1]!).toBeCloseTo(1 / 3);
    expect(bars.find((b) => b.fill)?.["data-label"]).toBe("B");
  });

  it("the chart is one undo step (plus the highlight)", () => {
    const ed = buildBarChart("Test", data);
    ed.undo(); // highlight
    ed.undo(); // chart
    expect(ed.doc.query()).toEqual([ed.doc.root]);
    expect(ed.canUndo()).toBe(false);
  });
});
