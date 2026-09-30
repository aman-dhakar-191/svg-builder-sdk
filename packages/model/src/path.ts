import SvgPath from "svgpath";
import { fail } from "./errors.js";
import { formatNumber } from "./geometry.js";
import type { Vec2 } from "./types.js";

/**
 * Path data as absolute segments, the form node editing works on.
 * H/V become L, S/T become C/Q (svgpath's unshort); arcs stay arcs.
 */
export type PathSegment =
  | { cmd: "M"; p: Vec2 }
  | { cmd: "L"; p: Vec2 }
  | { cmd: "C"; c1: Vec2; c2: Vec2; p: Vec2 }
  | { cmd: "Q"; c: Vec2; p: Vec2 }
  | { cmd: "A"; rx: number; ry: number; rotation: number; largeArc: boolean; sweep: boolean; p: Vec2 }
  | { cmd: "Z" };

/** Which point of a segment: its end point, or a control point. */
export type PathPoint = "p" | "c1" | "c2" | "c";

export function parsePath(d: string): PathSegment[] {
  const parsed = SvgPath(d);
  // svgpath reports parse errors on `err`; its type definitions leave it out.
  const err = (parsed as unknown as { err?: string }).err;
  if (err) {
    fail("INVALID_PATH", `The path data could not be parsed: ${err.replace(/^SvgPath: /, "")}.`, 'Path data looks like "M10 10 L50 10 C60 10 70 20 70 30 Z".');
  }
  const out: PathSegment[] = [];
  let x = 0;
  let y = 0;
  parsed.abs().unshort().iterate((s) => {
    switch (s[0]) {
      case "M":
        out.push({ cmd: "M", p: [s[1], s[2]] });
        break;
      case "L":
        out.push({ cmd: "L", p: [s[1], s[2]] });
        break;
      case "H":
        out.push({ cmd: "L", p: [s[1], y] });
        break;
      case "V":
        out.push({ cmd: "L", p: [x, s[1]] });
        break;
      case "C":
        out.push({ cmd: "C", c1: [s[1], s[2]], c2: [s[3], s[4]], p: [s[5], s[6]] });
        break;
      case "Q":
        out.push({ cmd: "Q", c: [s[1], s[2]], p: [s[3], s[4]] });
        break;
      case "A":
        out.push({ cmd: "A", rx: s[1], ry: s[2], rotation: s[3], largeArc: s[4] !== 0, sweep: s[5] !== 0, p: [s[6], s[7]] });
        break;
      case "Z":
      case "z":
        out.push({ cmd: "Z" });
        break;
      default:
        // abs().unshort() leaves only the cases above.
        break;
    }
    const last = out.at(-1);
    if (last && last.cmd !== "Z") [x, y] = last.p;
    else if (last?.cmd === "Z") [x, y] = subpathStart(out, out.length - 1);
  });
  return out;
}

/** The M point of the subpath that segment `i` belongs to. */
export function subpathStart(segs: PathSegment[], i: number): Vec2 {
  for (let k = i; k >= 0; k--) {
    const s = segs[k]!;
    if (s.cmd === "M") return s.p;
  }
  return [0, 0];
}

export function formatPath(segs: PathSegment[]): string {
  const f = (p: Vec2) => `${formatNumber(p[0])} ${formatNumber(p[1])}`;
  return segs
    .map((s) => {
      switch (s.cmd) {
        case "M":
        case "L":
          return `${s.cmd}${f(s.p)}`;
        case "C":
          return `C${f(s.c1)} ${f(s.c2)} ${f(s.p)}`;
        case "Q":
          return `Q${f(s.c)} ${f(s.p)}`;
        case "A":
          return `A${formatNumber(s.rx)} ${formatNumber(s.ry)} ${formatNumber(s.rotation)} ${s.largeArc ? 1 : 0} ${s.sweep ? 1 : 0} ${f(s.p)}`;
        case "Z":
          return "Z";
      }
    })
    .join(" ");
}

export interface PathMove {
  /** Segment index in parsePath() order. */
  seg: number;
  point: PathPoint;
  to: Vec2;
}

const near = (a: Vec2, b: Vec2) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/**
 * Applies point moves to a copy of `segs`. Moving an end point also moves its
 * handles (the incoming c2 and the next segment's c1) unless `handles` is
 * false, and moving a subpath's start also moves an explicit closing point
 * that sits on it, so closed shapes stay closed.
 */
export function movePathPoints(segs: PathSegment[], moves: PathMove[], handles = true): PathSegment[] {
  const out = segs.map((s) => JSON.parse(JSON.stringify(s)) as PathSegment);
  for (const m of moves) {
    const s = out[m.seg];
    if (!s) fail("INDEX_OUT_OF_RANGE", `pathEdit: segment ${m.seg} does not exist; the path has ${out.length} segments (0..${out.length - 1}).`, "Get the segments with getPath(id).");
    if (s.cmd === "Z") fail("INVALID_COMMAND", `pathEdit: segment ${m.seg} is a close (Z) and has no points.`, "Move the subpath's start point (its M segment) instead.");
    if (m.point === "p") {
      const dx = m.to[0] - s.p[0];
      const dy = m.to[1] - s.p[1];
      const shift = (v: Vec2): Vec2 => [v[0] + dx, v[1] + dy];
      if (handles) {
        if (s.cmd === "C") s.c2 = shift(s.c2);
        const next = out[m.seg + 1];
        if (next?.cmd === "C") next.c1 = shift(next.c1);
      }
      if (s.cmd === "M") {
        // An explicit closing point on the start: move it too, and the handle into it.
        let k = m.seg + 1;
        while (k < out.length && out[k]!.cmd !== "M" && out[k]!.cmd !== "Z") k++;
        const last = out[k - 1];
        if (out[k]?.cmd === "Z" && k - 1 > m.seg && last && last.cmd !== "Z" && last.cmd !== "M" && near(last.p, s.p)) {
          if (handles && last.cmd === "C") last.c2 = shift(last.c2);
          last.p = [...m.to] as Vec2;
        }
      }
      s.p = [...m.to] as Vec2;
    } else if (m.point === "c" && s.cmd === "Q") {
      s.c = [...m.to] as Vec2;
    } else if ((m.point === "c1" || m.point === "c2") && s.cmd === "C") {
      s[m.point] = [...m.to] as Vec2;
    } else {
      fail("INVALID_COMMAND", `pathEdit: segment ${m.seg} is "${s.cmd}" and has no "${m.point}" point.`, 'C segments have c1, c2 and p; Q has c and p; M, L and A have p.');
    }
  }
  return out;
}

/** Path data equivalent to a basic shape, or a reason it cannot be converted. */
export function shapeToPath(tag: string, a: Record<string, string>): { d: string; used: string[] } | { error: string } {
  const num = (name: string, def?: number): number | null => {
    const v = a[name];
    if (v === undefined) return def ?? null;
    const m = /^\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*(px)?\s*$/i.exec(v);
    return m ? Number(m[1]) : null;
  };
  const f = formatNumber;
  const need = (...names: string[]) => names.find((n) => num(n, 0) === null);
  switch (tag) {
    case "rect": {
      const bad = need("x", "y", "width", "height", "rx", "ry");
      if (bad) return { error: `its ${bad} "${a[bad]}" is not a plain number` };
      const x = num("x", 0)!;
      const y = num("y", 0)!;
      const w = num("width", 0)!;
      const h = num("height", 0)!;
      if (w <= 0 || h <= 0) return { error: "it has no width or height" };
      let rx = a.rx !== undefined ? num("rx")! : a.ry !== undefined ? num("ry")! : 0;
      let ry = a.ry !== undefined ? num("ry")! : rx;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);
      const used = ["x", "y", "width", "height", "rx", "ry"];
      if (rx === 0 || ry === 0) return { d: `M${f(x)} ${f(y)} H${f(x + w)} V${f(y + h)} H${f(x)} Z`, used };
      const arc = `A${f(rx)} ${f(ry)} 0 0 1`;
      return {
        d: `M${f(x + rx)} ${f(y)} H${f(x + w - rx)} ${arc} ${f(x + w)} ${f(y + ry)} V${f(y + h - ry)} ${arc} ${f(x + w - rx)} ${f(y + h)} H${f(x + rx)} ${arc} ${f(x)} ${f(y + h - ry)} V${f(y + ry)} ${arc} ${f(x + rx)} ${f(y)} Z`,
        used,
      };
    }
    case "circle":
    case "ellipse": {
      const bad = tag === "circle" ? need("cx", "cy", "r") : need("cx", "cy", "rx", "ry");
      if (bad) return { error: `its ${bad} "${a[bad]}" is not a plain number` };
      const cx = num("cx", 0)!;
      const cy = num("cy", 0)!;
      const rx = tag === "circle" ? num("r", 0)! : num("rx", 0)!;
      const ry = tag === "circle" ? rx : num("ry", 0)!;
      if (rx <= 0 || ry <= 0) return { error: "its radius is zero" };
      const arc = `A${f(rx)} ${f(ry)} 0 1 1`;
      return {
        d: `M${f(cx - rx)} ${f(cy)} ${arc} ${f(cx + rx)} ${f(cy)} ${arc} ${f(cx - rx)} ${f(cy)} Z`,
        used: tag === "circle" ? ["cx", "cy", "r"] : ["cx", "cy", "rx", "ry"],
      };
    }
    case "line": {
      const bad = need("x1", "y1", "x2", "y2");
      if (bad) return { error: `its ${bad} "${a[bad]}" is not a plain number` };
      return { d: `M${f(num("x1", 0)!)} ${f(num("y1", 0)!)} L${f(num("x2", 0)!)} ${f(num("y2", 0)!)}`, used: ["x1", "y1", "x2", "y2"] };
    }
    case "polyline":
    case "polygon": {
      const nums = (a.points ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
      if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return { error: "its points are missing or invalid" };
      const pts: string[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push(`${f(nums[i]!)} ${f(nums[i + 1]!)}`);
      return { d: `M${pts[0]} ${pts.slice(1).map((p) => `L${p}`).join(" ")}${tag === "polygon" ? " Z" : ""}`, used: ["points"] };
    }
    default:
      return { error: `<${tag}> is not a basic shape (rect, circle, ellipse, line, polyline, polygon)` };
  }
}
