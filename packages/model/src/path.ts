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
 * that sits on it, so closed shapes stay closed. Moving one handle of a smooth node
 * (handles in line) turns the other with it unless `handles` is false.
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
      // A smooth node stays smooth: the handle across the node turns to stay in line (same length).
      const opp = handles ? oppositeHandle(out, m.seg, m.point) : null;
      s[m.point] = [...m.to] as Vec2;
      if (opp) {
        const o = out[opp.seg] as Cubic;
        const away = sub(opp.anchor, m.to);
        const d = len(away);
        if (d > 1e-9) o[opp.point] = add(opp.anchor, scale(away, len(sub(o[opp.point], opp.anchor)) / d));
      }
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

// ------------------------------------------------------------------ node editing

/**
 * One node-level change. `seg` is a segment index in parsePath() order; a node is the
 * end point of its segment (an M is a subpath's start).
 * - insert: splits segment `seg` at `t` (0..1) without changing the outline. A Z segment
 *   splits the implicit closing line.
 * - delete: removes the node at the end of `seg`; its two neighbouring segments join.
 * - node: "corner" pulls the node's handles into it (a sharp point); "smooth" lines them
 *   up on one tangent, turning neighbouring lines into curves.
 * - segment: "line" straightens segment `seg`; "curve" makes it a cubic with handles.
 */
export type PathNodeOp =
  | { action: "insert"; seg: number; t: number }
  | { action: "delete"; seg: number }
  | { action: "node"; seg: number; type: "corner" | "smooth" }
  | { action: "segment"; seg: number; type: "line" | "curve" };

type Drawn = Exclude<PathSegment, { cmd: "Z" }>;
type Cubic = Extract<PathSegment, { cmd: "C" }>;

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const scale = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const len = (a: Vec2): number => Math.hypot(a[0], a[1]);
const copy = (segs: PathSegment[]): PathSegment[] => segs.map((s) => JSON.parse(JSON.stringify(s)) as PathSegment);

/** Where segment `i` starts: the previous end point, or its subpath's start after a Z. */
export function segmentStart(segs: PathSegment[], i: number): Vec2 {
  const prev = segs[i - 1];
  if (!prev) return [0, 0];
  return prev.cmd === "Z" ? subpathStart(segs, i - 1) : prev.p;
}

/** The subpath around segment `i`: its M index, the index after its last drawn segment, and whether a Z closes it. */
function subpathOf(segs: PathSegment[], i: number): { m: number; end: number; closed: boolean; explicit: boolean } {
  let m = i;
  while (m > 0 && segs[m]!.cmd !== "M") m--;
  let end = m + 1;
  while (end < segs.length && segs[end]!.cmd !== "M" && segs[end]!.cmd !== "Z") end++;
  const closed = segs[end]?.cmd === "Z";
  const last = segs[end - 1]!;
  const explicit = closed && end - 1 > m && last.cmd !== "Z" && near((last as Drawn).p, (segs[m] as Drawn).p);
  return { m, end, closed, explicit };
}

/** A segment as a cubic with the same outline (lines get handles at thirds; arcs are not handled here). */
function toCubic(s: Drawn, start: Vec2): Cubic {
  if (s.cmd === "C") return s;
  if (s.cmd === "Q") return { cmd: "C", c1: lerp(start, s.c, 2 / 3), c2: lerp(s.p, s.c, 2 / 3), p: s.p };
  return { cmd: "C", c1: lerp(start, s.p, 1 / 3), c2: lerp(start, s.p, 2 / 3), p: s.p };
}

/** Arc segment as cubics (svgpath's unarc), for "curve". */
function arcToCubics(s: Extract<PathSegment, { cmd: "A" }>, start: Vec2): Cubic[] {
  const f = formatNumber;
  const d = `M${f(start[0])} ${f(start[1])} A${f(s.rx)} ${f(s.ry)} ${f(s.rotation)} ${s.largeArc ? 1 : 0} ${s.sweep ? 1 : 0} ${f(s.p[0])} ${f(s.p[1])}`;
  const out = parsePath(SvgPath(d).unarc().toString()).slice(1);
  const cubics = out.map((c, k) => (c.cmd === "C" ? c : toCubic(c as Drawn, k === 0 ? start : (out[k - 1] as Drawn).p)));
  // Keep the exact end point (unarc rounds).
  if (cubics.length) cubics[cubics.length - 1]!.p = [...s.p] as Vec2;
  return cubics.length ? cubics : [toCubic({ cmd: "L", p: s.p }, start)];
}

/** Splits an arc at parameter t (SVG arc implementation notes, F.6.5). */
function splitArc(s: Extract<PathSegment, { cmd: "A" }>, start: Vec2, t: number): [PathSegment, PathSegment] {
  let rx = Math.abs(s.rx);
  let ry = Math.abs(s.ry);
  const [x1, y1] = start;
  const [x2, y2] = s.p;
  if (rx === 0 || ry === 0 || near(start, s.p)) return [{ cmd: "L", p: lerp(start, s.p, t) }, { cmd: "L", p: s.p }];
  const phi = (s.rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const xp = (cos * (x1 - x2)) / 2 + (sin * (y1 - y2)) / 2;
  const yp = (-sin * (x1 - x2)) / 2 + (cos * (y1 - y2)) / 2;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const coef = (s.largeArc !== s.sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * yp) / ry;
  const cyp = (-coef * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (u: Vec2, v: Vec2) => Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]);
  const theta1 = angle([1, 0], [(xp - cxp) / rx, (yp - cyp) / ry]);
  let delta = angle([(xp - cxp) / rx, (yp - cyp) / ry], [(-xp - cxp) / rx, (-yp - cyp) / ry]);
  if (!s.sweep && delta > 0) delta -= 2 * Math.PI;
  if (s.sweep && delta < 0) delta += 2 * Math.PI;
  const th = theta1 + t * delta;
  const mid: Vec2 = [cx + rx * cos * Math.cos(th) - ry * sin * Math.sin(th), cy + rx * sin * Math.cos(th) + ry * cos * Math.sin(th)];
  const base = { rx, ry, rotation: s.rotation, sweep: s.sweep };
  return [
    { cmd: "A", ...base, largeArc: Math.abs(t * delta) > Math.PI, p: mid },
    { cmd: "A", ...base, largeArc: Math.abs((1 - t) * delta) > Math.PI, p: [...s.p] as Vec2 },
  ];
}

/** One segment from a's start to b's end, replacing the node between them. */
function joinSegments(a: Drawn, b: Drawn, start: Vec2): Drawn {
  const end = b.p;
  const curved = (s: Drawn) => s.cmd === "C" || s.cmd === "Q";
  if (!curved(a) && !curved(b)) return { cmd: "L", p: end };
  const c1 = a.cmd === "C" ? a.c1 : a.cmd === "Q" ? lerp(start, a.c, 2 / 3) : start;
  const c2 = b.cmd === "C" ? b.c2 : b.cmd === "Q" ? lerp(end, b.c, 2 / 3) : end;
  return { cmd: "C", c1, c2, p: end };
}

function drawnAt(segs: PathSegment[], seg: number, action: string): Drawn {
  const s = segs[seg];
  if (!s) fail("INDEX_OUT_OF_RANGE", `pathNode: segment ${seg} does not exist; the path has ${segs.length} segments (0..${segs.length - 1}).`, "Get the segments with getPath(id).");
  if (s.cmd === "Z") fail("INVALID_COMMAND", `pathNode ${action}: segment ${seg} is a close (Z), which has no node.`, "The closing node is the subpath's start (its M segment).");
  return s;
}

/**
 * The node at the end of `seg` in a closed subpath with an explicit closing point is the
 * same node as the subpath's start; use the M index for it.
 */
function canonicalNode(segs: PathSegment[], seg: number): number {
  const sp = subpathOf(segs, seg);
  return sp.explicit && seg === sp.end - 1 ? sp.m : seg;
}

/** Applies a node-level change to a copy of `segs`. */
export function editPathNode(input: PathSegment[], op: PathNodeOp): PathSegment[] {
  const segs = copy(input);
  switch (op.action) {
    case "insert": {
      const s = segs[op.seg];
      if (!s) drawnAt(segs, op.seg, "insert");
      if (!(op.t > 0 && op.t < 1)) fail("INVALID_COMMAND", `pathNode insert: t must be between 0 and 1 (exclusive); got ${op.t}.`, "0.5 inserts in the middle of the segment.");
      const start = segmentStart(segs, op.seg);
      if (s!.cmd === "M") fail("INVALID_COMMAND", `pathNode insert: segment ${op.seg} is a move (M), which draws nothing.`, "Insert on a drawn segment (L, C, Q, A) or a closing Z.");
      let parts: PathSegment[];
      if (s!.cmd === "Z") {
        const to = subpathStart(segs, op.seg);
        if (near(start, to)) fail("INVALID_COMMAND", `pathNode insert: the closing line at segment ${op.seg} has no length.`, "Insert on another segment.");
        parts = [{ cmd: "L", p: lerp(start, to, op.t) }, { cmd: "Z" }];
      } else if (s!.cmd === "L") {
        parts = [{ cmd: "L", p: lerp(start, s!.p, op.t) }, s!];
      } else if (s!.cmd === "C") {
        const a = lerp(start, s!.c1, op.t);
        const b = lerp(s!.c1, s!.c2, op.t);
        const c = lerp(s!.c2, s!.p, op.t);
        const d = lerp(a, b, op.t);
        const e = lerp(b, c, op.t);
        parts = [{ cmd: "C", c1: a, c2: d, p: lerp(d, e, op.t) }, { cmd: "C", c1: e, c2: c, p: s!.p }];
      } else if (s!.cmd === "Q") {
        const a = lerp(start, s!.c, op.t);
        const b = lerp(s!.c, s!.p, op.t);
        parts = [{ cmd: "Q", c: a, p: lerp(a, b, op.t) }, { cmd: "Q", c: b, p: s!.p }];
      } else {
        parts = splitArc(s!, start, op.t);
      }
      segs.splice(op.seg, 1, ...parts);
      return segs;
    }

    case "delete": {
      drawnAt(segs, op.seg, "delete");
      const seg = canonicalNode(segs, op.seg);
      const sp = subpathOf(segs, seg);
      const nodes = sp.end - sp.m - (sp.explicit ? 1 : 0);
      if (nodes <= 2) fail("TOO_FEW_POINTS", `pathNode delete: the subpath has only ${nodes} points; a path needs at least two.`, "Delete the whole element instead.");
      if (seg === sp.m) {
        const next = segs[sp.m + 1] as Drawn;
        const newStart = next.p;
        if (sp.closed) {
          // The closing edge into the old start and the first edge out of it become one edge.
          const lastIdx = sp.end - 1;
          const last = segs[lastIdx] as Drawn;
          const closing: Drawn = sp.explicit ? last : { cmd: "L", p: (segs[sp.m] as Drawn).p };
          const from = sp.explicit ? segmentStart(segs, lastIdx) : last.p;
          const joined = joinSegments(closing, next, from);
          if (sp.explicit) segs[lastIdx] = joined;
          else segs.splice(sp.end, 0, joined);
        }
        segs.splice(sp.m, 2, { cmd: "M", p: [...newStart] as Vec2 });
        return segs;
      }
      if (seg === sp.end - 1) {
        if (!sp.closed) {
          segs.splice(seg, 1);
          return segs;
        }
        // The last node before an implicit close: the close now runs from the previous node.
        const joined = joinSegments(segs[seg] as Drawn, { cmd: "L", p: (segs[sp.m] as Drawn).p }, segmentStart(segs, seg));
        segs.splice(seg, 1, ...(joined.cmd === "L" ? [] : [joined]));
        return segs;
      }
      segs.splice(seg, 2, joinSegments(segs[seg] as Drawn, segs[seg + 1] as Drawn, segmentStart(segs, seg)));
      return segs;
    }

    case "segment": {
      const s = segs[op.seg];
      if (!s) drawnAt(segs, op.seg, "segment");
      if (s!.cmd === "M") fail("INVALID_COMMAND", `pathNode segment: segment ${op.seg} is a move (M), which draws nothing.`, "Pick a drawn segment (L, C, Q, A) or a closing Z.");
      const start = segmentStart(segs, op.seg);
      if (s!.cmd === "Z") {
        if (op.type === "curve") segs.splice(op.seg, 0, toCubic({ cmd: "L", p: subpathStart(segs, op.seg) }, start));
        return segs;
      }
      if (op.type === "line") segs[op.seg] = { cmd: "L", p: s!.p };
      else if (s!.cmd === "A") segs.splice(op.seg, 1, ...arcToCubics(s!, start));
      else segs[op.seg] = toCubic(s!, start);
      return segs;
    }

    case "node": {
      drawnAt(segs, op.seg, "node");
      let seg = canonicalNode(segs, op.seg);
      let sp = subpathOf(segs, seg);
      const smooth = op.type === "smooth";
      if (smooth && sp.closed && !sp.explicit && seg === sp.m) {
        // Give the implicit closing line a real segment so the start node has an incoming side.
        segs.splice(sp.end, 0, { cmd: "L", p: [...(segs[sp.m] as Drawn).p] as Vec2 });
        sp = subpathOf(segs, seg);
      }
      if (smooth && sp.closed && seg === sp.end - 1 && !sp.explicit) {
        // The last node before an implicit close: make the closing line explicit for its outgoing side.
        segs.splice(sp.end, 0, { cmd: "L", p: [...(segs[sp.m] as Drawn).p] as Vec2 });
        sp = subpathOf(segs, seg);
      }
      seg = canonicalNode(segs, seg);
      const inIdx = seg === sp.m ? (sp.closed && sp.explicit ? sp.end - 1 : -1) : seg;
      const outIdx = seg === sp.m ? sp.m + 1 : seg + 1 < sp.end ? seg + 1 : -1;
      const anchor = (segs[seg] as Drawn).p;
      if (op.type === "corner") {
        for (const [idx, side] of [[inIdx, "c2"], [outIdx, "c1"]] as const) {
          if (idx < 0) continue;
          const s = segs[idx] as Drawn;
          if (s.cmd === "C") s[side] = [...anchor] as Vec2;
          else if (s.cmd === "Q") segs[idx] = { ...toCubic(s, segmentStart(segs, idx)), [side]: [...anchor] as Vec2 };
        }
        return segs;
      }
      if (inIdx < 0 || outIdx < 0) fail("INVALID_COMMAND", `pathNode node: the node at segment ${op.seg} is an end of an open path, with a curve on one side only.`, "Only nodes between two segments can be smooth.");
      for (const idx of [inIdx, outIdx]) {
        const s = segs[idx] as Drawn;
        if (s.cmd === "A") fail("INVALID_COMMAND", `pathNode node: segment ${idx} next to this node is an arc.`, `Make it a curve first: { action: "segment", seg: ${idx}, type: "curve" }.`);
        if (s.cmd !== "C") segs[idx] = toCubic(s, segmentStart(segs, idx));
      }
      const into = segs[inIdx] as Cubic;
      const out = segs[outIdx] as Cubic;
      const prev = segmentStart(segs, inIdx);
      let dir = sub(out.c1, into.c2);
      if (len(dir) < 1e-9) dir = sub(out.p, prev);
      if (len(dir) < 1e-9) return segs;
      dir = scale(dir, 1 / len(dir));
      const inLen = len(sub(anchor, into.c2)) || len(sub(anchor, prev)) / 3;
      const outLen = len(sub(out.c1, anchor)) || len(sub(out.p, anchor)) / 3;
      into.c2 = sub(anchor, scale(dir, inLen));
      out.c1 = add(anchor, scale(dir, outLen));
      return segs;
    }
  }
}

/**
 * For a handle about to move: the handle on the other side of the same node, when the two
 * currently line up (a smooth node), so a drag can keep them in line.
 */
export function oppositeHandle(segs: PathSegment[], seg: number, point: "c1" | "c2"): { seg: number; point: "c1" | "c2"; anchor: Vec2 } | null {
  const s = segs[seg];
  if (s?.cmd !== "C") return null;
  let other: number;
  let anchor: Vec2;
  if (point === "c2") {
    anchor = s.p;
    const sp = subpathOf(segs, seg);
    other = sp.explicit && seg === sp.end - 1 ? sp.m + 1 : seg + 1;
  } else {
    anchor = segmentStart(segs, seg);
    const sp = subpathOf(segs, seg);
    other = seg === sp.m + 1 ? (sp.explicit ? sp.end - 1 : -1) : seg - 1;
  }
  const o = segs[other];
  if (!o || o.cmd !== "C") return null;
  const otherPoint = point === "c2" ? "c1" : "c2";
  const a = sub(s[point], anchor);
  const b = sub(o[otherPoint], anchor);
  if (len(a) < 1e-9 || len(b) < 1e-9) return null;
  // Opposite directions within about half a degree.
  const cosAngle = (a[0] * b[0] + a[1] * b[1]) / (len(a) * len(b));
  return cosAngle < -0.99996 ? { seg: other, point: otherPoint, anchor } : null;
}

/** The point at `t` (0..1) along segment `i` (a Z is its closing line). */
export function pointOnSegment(segs: PathSegment[], i: number, t: number): Vec2 {
  const s = segs[i];
  const start = segmentStart(segs, i);
  if (!s || s.cmd === "M") return s?.cmd === "M" ? s.p : start;
  if (s.cmd === "Z") return lerp(start, subpathStart(segs, i), t);
  if (s.cmd === "L") return lerp(start, s.p, t);
  if (s.cmd === "Q") return lerp(lerp(start, s.c, t), lerp(s.c, s.p, t), t);
  if (s.cmd === "C") {
    const a = lerp(start, s.c1, t);
    const b = lerp(s.c1, s.c2, t);
    const c = lerp(s.c2, s.p, t);
    return lerp(lerp(a, b, t), lerp(b, c, t), t);
  }
  if (t <= 0) return start;
  if (t >= 1) return s.p;
  return (splitArc(s, start, t)[0] as Drawn).p;
}

/** The closest point on the outline to `to`: its segment, where on it (t), and how far. */
export function nearestOnPath(segs: PathSegment[], to: Vec2): { seg: number; t: number; point: Vec2; distance: number } | null {
  let best: { seg: number; t: number; point: Vec2; distance: number } | null = null;
  const dist = (p: Vec2) => len(sub(p, to));
  segs.forEach((s, i) => {
    if (s.cmd === "M") return;
    // Coarse samples, then a local refinement around the best one.
    const N = 48;
    let bt = 0;
    let bd = Infinity;
    for (let k = 0; k <= N; k++) {
      const d = dist(pointOnSegment(segs, i, k / N));
      if (d < bd) [bd, bt] = [d, k / N];
    }
    let lo = Math.max(0, bt - 1 / N);
    let hi = Math.min(1, bt + 1 / N);
    for (let k = 0; k < 30; k++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      if (dist(pointOnSegment(segs, i, m1)) < dist(pointOnSegment(segs, i, m2))) hi = m2;
      else lo = m1;
    }
    const t = (lo + hi) / 2;
    const point = pointOnSegment(segs, i, t);
    const d = dist(point);
    if (!best || d < best.distance) best = { seg: i, t, point, distance: d };
  });
  return best;
}
