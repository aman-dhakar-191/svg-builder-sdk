/**
 * Headless example: builds a bar chart SVG from data, with no DOM and no UI.
 *
 *   pnpm --filter @svg-editor/sdk build
 *   node --experimental-strip-types packages/sdk/examples/bar-chart.ts chart.svg
 *
 * (Node 23.6+ runs .ts files without the flag.) Without a file name the SVG
 * is printed to stdout.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createEditor, SvgEditorError, type Editor } from "@svg-editor/sdk";

export interface Datum {
  label: string;
  value: number;
}

const WIDTH = 480;
const HEIGHT = 300;
const PAD = { top: 40, right: 20, bottom: 40, left: 48 };

export function buildBarChart(title: string, data: Datum[]): Editor {
  const editor = createEditor({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" font-family="sans-serif">\n</svg>\n`,
  });
  const { doc } = editor;
  const max = Math.max(...data.map((d) => d.value), 1);
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = plotW / data.length;

  // The whole chart is one undo step.
  editor.batch(() => {
    doc.add("rect", { width: WIDTH, height: HEIGHT, fill: "#ffffff" });
    doc.addText(title, { x: PAD.left, y: 26, "font-size": 16, "font-weight": "bold", fill: "#111827" });

    const axis = doc.add("g", { id: "axis", stroke: "#9ca3af" });
    doc.add("line", { x1: PAD.left, y1: PAD.top + plotH, x2: WIDTH - PAD.right, y2: PAD.top + plotH }, { parent: axis });
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      const y = PAD.top + plotH - (v / max) * plotH;
      doc.add("line", { x1: PAD.left - 4, y1: y, x2: PAD.left, y2: y }, { parent: axis });
      doc.addText(String(Math.round(v)), { x: PAD.left - 8, y: y + 4, "font-size": 10, "text-anchor": "end", fill: "#6b7280", stroke: "none" }, { parent: axis });
    }

    const bars = doc.add("g", { id: "bars", fill: "#4f46e5" });
    data.forEach((d, i) => {
      const h = (d.value / max) * plotH;
      const x = PAD.left + i * slot + slot * 0.15;
      doc.add("rect", { x, y: PAD.top + plotH - h, width: slot * 0.7, height: h, rx: 3, "data-label": d.label }, { parent: bars });
      doc.addText(d.label, { x: x + slot * 0.35, y: HEIGHT - PAD.bottom + 16, "font-size": 11, "text-anchor": "middle", fill: "#374151" });
    });
  });

  // Queries and geometry work headlessly too: highlight the tallest bar.
  const tallest = doc
    .query({ tag: "rect", attr: { "data-label": true } })
    .reduce((best, id) => (doc.getBBox(id).height > doc.getBBox(best).height ? id : best));
  doc.set(tallest, { fill: "#f59e0b" });

  return editor;
}

// Run as a script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const editor = buildBarChart("Downloads per month", [
      { label: "Jan", value: 120 },
      { label: "Feb", value: 180 },
      { label: "Mar", value: 150 },
      { label: "Apr", value: 240 },
      { label: "May", value: 210 },
    ]);
    const svg = editor.toSvg({ pretty: true }) + "\n";
    const out = process.argv.slice(2).find((a) => a !== "--");
    if (out) {
      writeFileSync(out, svg);
      console.error(`wrote ${out} (${editor.doc.query().length - 1} elements)`);
    } else {
      process.stdout.write(svg);
    }
  } catch (e) {
    // Every SDK failure is an SvgEditorError with a stable code and a hint.
    if (e instanceof SvgEditorError) console.error(`${e.code}: ${e.message}\n  hint: ${e.hint}`);
    throw e;
  }
}
