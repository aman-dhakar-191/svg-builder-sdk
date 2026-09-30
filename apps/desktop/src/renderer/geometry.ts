/**
 * Pure 2D math for canvas gestures. No DOM: DOMMatrix values are copied into
 * `Mat` so this runs (and is tested) in Node.
 */

export interface Point {
  x: number;
  y: number;
}

/** Affine matrix with DOMMatrix's field names. */
export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function mat(m: Mat): Mat {
  return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
}

export function apply(m: Mat, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** Applies only the linear part (for direction vectors such as drag deltas). */
export function applyLinear(m: Mat, v: Point): Point {
  return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y };
}

export function invert(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) throw new Error("matrix is not invertible");
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export function corners(r: Rect): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
}

export function boundsOf(points: Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Normalized rectangle between two drag points; `square` forces equal sides. */
export function rectFromPoints(p0: Point, p1: Point, square = false): Rect {
  let dx = p1.x - p0.x;
  let dy = p1.y - p0.y;
  if (square) {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * s;
    dy = Math.sign(dy || 1) * s;
  }
  return { x: Math.min(p0.x, p0.x + dx), y: Math.min(p0.y, p0.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
}

export function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

/** Handle names: corners and edge midpoints ("n", "ne", ...). */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Where a handle sits on a box, as fractions of width/height. */
export function handleFraction(h: Handle): Point {
  return { x: h.includes("w") ? 0 : h.includes("e") ? 1 : 0.5, y: h.includes("n") ? 0 : h.includes("s") ? 1 : 0.5 };
}

export function handlePoint(r: Rect, h: Handle): Point {
  const f = handleFraction(h);
  return { x: r.x + r.width * f.x, y: r.y + r.height * f.y };
}

/** The point that stays fixed while dragging `h`. */
export function anchorPoint(r: Rect, h: Handle): Point {
  const f = handleFraction(h);
  return { x: r.x + r.width * (1 - f.x), y: r.y + r.height * (1 - f.y) };
}

const MIN_SCALE = 0.01;

/**
 * Scale factors for dragging handle `h` of box `r` to `p` (all in one space).
 * Edge handles scale one axis. `keepAspect` uses the larger factor for both.
 * Factors never reach 0 (a zero scale would collapse the element); dragging
 * past the anchor flips the element (negative factor).
 */
export function resizeScale(r: Rect, h: Handle, p: Point, keepAspect = false): [number, number] {
  const a = anchorPoint(r, h);
  const start = handlePoint(r, h);
  const f = handleFraction(h);
  const factor = (from: number, to: number, anchor: number) => {
    const span = from - anchor;
    if (Math.abs(span) < 1e-9) return 1;
    const s = (to - anchor) / span;
    return Math.abs(s) < MIN_SCALE ? Math.sign(s || 1) * MIN_SCALE : s;
  };
  let sx = f.x === 0.5 ? 1 : factor(start.x, p.x, a.x);
  let sy = f.y === 0.5 ? 1 : factor(start.y, p.y, a.y);
  if (keepAspect) {
    const edge = f.x === 0.5 ? sy : f.y === 0.5 ? sx : Math.abs(sx) > Math.abs(sy) ? sx : sy;
    sx = Math.sign(sx) * Math.abs(edge);
    sy = Math.sign(sy) * Math.abs(edge);
  }
  return [sx, sy];
}

/** Clockwise angle in degrees from `p0` to `p1` around `center` (screen space, y down). */
export function angleBetween(center: Point, p0: Point, p1: Point): number {
  const a0 = Math.atan2(p0.y - center.y, p0.x - center.x);
  const a1 = Math.atan2(p1.y - center.y, p1.x - center.x);
  let deg = ((a1 - a0) * 180) / Math.PI;
  if (deg > 180) deg -= 360;
  if (deg <= -180) deg += 360;
  return deg;
}

export function snap(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** Rounds for attribute output (2 decimals, no "-0"). */
export function round(n: number): number {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/** Smallest "nice" step (1, 2 or 5 x 10^n) that is at least `min`. */
export function niceStep(min: number): number {
  if (!(min > 0) || !Number.isFinite(min)) return 1;
  const pow = 10 ** Math.floor(Math.log10(min));
  for (const m of [1, 2, 5, 10]) if (m * pow >= min - 1e-12) return m * pow;
  return 10 * pow;
}

/** Zoom levels the zoom-in / zoom-out commands step through. */
export const ZOOM_LEVELS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 32];

export function nextZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_LEVELS.find((z) => z > current + 1e-9) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!;
  return [...ZOOM_LEVELS].reverse().find((z) => z < current - 1e-9) ?? ZOOM_LEVELS[0]!;
}

/** Zoom that makes `content` fit inside `view` with a margin (tiny icons get enlarged). */
export function fitZoom(content: { width: number; height: number }, view: { width: number; height: number }, margin = 48): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  const z = Math.min((view.width - margin) / content.width, (view.height - margin) / content.height);
  return Math.max(0.05, Math.min(z, 32));
}

export function snapPoint(p: Point, step: number): Point {
  return { x: snap(p.x, step), y: snap(p.y, step) };
}
