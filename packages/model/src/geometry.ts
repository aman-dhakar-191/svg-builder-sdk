import type { BBox, Vec2 } from "./types.js";

/** Affine matrix [a, b, c, d, e, f], same layout as SVG's matrix(). */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyToPoint(m: Matrix, [x, y]: Vec2): Vec2 {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export interface TransformOp {
  name: string;
  args: number[];
  /** Offset just past this op's closing paren in the source string. */
  end: number;
}

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
const OP_ARITY: Record<string, number[]> = {
  matrix: [6],
  translate: [1, 2],
  scale: [1, 2],
  rotate: [1, 3],
  skewX: [1],
  skewY: [1],
};

/** Parses an SVG transform list. Returns null if the string is not a valid list. */
export function parseTransformList(source: string): TransformOp[] | null {
  const ops: TransformOp[] = [];
  let i = 0;
  const skipWs = (commaOk: boolean) => {
    let sawComma = false;
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") i++;
      else if (commaOk && ch === "," && !sawComma) {
        sawComma = true;
        i++;
      } else break;
    }
  };

  skipWs(false);
  while (i < source.length) {
    const nameMatch = /^[A-Za-z]+/.exec(source.slice(i));
    if (!nameMatch) return null;
    const name = nameMatch[0];
    const arity = OP_ARITY[name];
    if (!arity) return null;
    i += name.length;
    skipWs(false);
    if (source[i] !== "(") return null;
    i++;
    const args: number[] = [];
    skipWs(false);
    while (source[i] !== ")") {
      if (args.length > 0) skipWs(true);
      NUMBER.lastIndex = i;
      const num = NUMBER.exec(source);
      if (!num) return null;
      args.push(Number(num[0]));
      i = NUMBER.lastIndex;
      skipWs(false);
      if (i >= source.length) return null;
    }
    if (!arity.includes(args.length)) return null;
    i++;
    ops.push({ name, args, end: i });
    skipWs(true);
  }
  return ops;
}

function opToMatrix({ name, args }: TransformOp): Matrix {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  switch (name) {
    case "matrix":
      return args.slice(0, 6) as Matrix;
    case "translate":
      return [1, 0, 0, 1, args[0]!, args[1] ?? 0];
    case "scale":
      return [args[0]!, 0, 0, args[1] ?? args[0]!, 0, 0];
    case "rotate": {
      const a = rad(args[0]!);
      const r: Matrix = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
      if (args.length === 3) {
        const [cx, cy] = [args[1]!, args[2]!];
        return multiply(multiply([1, 0, 0, 1, cx, cy], r), [1, 0, 0, 1, -cx, -cy]);
      }
      return r;
    }
    case "skewX":
      return [1, 0, Math.tan(rad(args[0]!)), 1, 0, 0];
    case "skewY":
      return [1, Math.tan(rad(args[0]!)), 0, 1, 0, 0];
    default:
      throw new Error(`unreachable transform op ${name}`);
  }
}

/** Matrix for a transform attribute value; null if it cannot be parsed. */
export function parseTransform(source: string | undefined): Matrix | null {
  if (source === undefined) return IDENTITY;
  const ops = parseTransformList(source);
  if (!ops) return null;
  return ops.reduce<Matrix>((m, op) => multiply(m, opToMatrix(op)), IDENTITY);
}

/** Formats a number for attribute output: at most 6 decimals, no trailing zeros, no "-0". */
export function formatNumber(n: number): string {
  const rounded = Math.round(n * 1e6) / 1e6;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Parses a plain user-unit length ("10", "10.5", "10px"). Percentages and
 * other units need a viewport, which the headless model does not have.
 */
export function parseLength(value: string | undefined, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(px)?\s*$/.exec(value);
  return m ? Number(m[1]) : null;
}

export function parsePoints(value: string | undefined): Vec2[] | null {
  if (value === undefined) return [];
  const nums = value.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  if (nums.length % 2 !== 0) return null;
  const pts: Vec2[] = [];
  for (let i = 0; i < nums.length; i += 2) pts.push([Number(nums[i]), Number(nums[i + 1])]);
  return pts;
}

export function bboxOfPoints(points: Vec2[]): BBox | null {
  if (points.length === 0) return null;
  let [minX, minY] = points[0]!;
  let [maxX, maxY] = points[0]!;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function transformBBox(m: Matrix, b: BBox): BBox {
  const corners: Vec2[] = [
    [b.x, b.y],
    [b.x + b.width, b.y],
    [b.x, b.y + b.height],
    [b.x + b.width, b.y + b.height],
  ];
  return bboxOfPoints(corners.map((p) => applyToPoint(m, p)))!;
}

export function unionBBox(boxes: BBox[]): BBox | null {
  const pts: Vec2[] = [];
  for (const b of boxes) pts.push([b.x, b.y], [b.x + b.width, b.y + b.height]);
  return bboxOfPoints(pts);
}
