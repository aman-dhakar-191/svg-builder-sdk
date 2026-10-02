import { MOTION_EASINGS, type MotionEasing } from "./animation.js";
import { formatNumber } from "./geometry.js";
import type { BBox, NodeId } from "./types.js";

/**
 * Keyframes: per element and property, values at points in time, played from
 * the start of the timeline. Stored as SMIL (one track per property, tagged
 * data-motion="keys" data-key="<property>") so the file plays anywhere SVG
 * animates. data-keys holds the key times in seconds; data-ease the easing.
 */
export const KEY_PROPERTIES = ["translate", "rotate", "scale", "opacity", "fill", "stroke"] as const;
export type KeyProperty = (typeof KEY_PROPERTIES)[number];
/** translate: [dx, dy] (the element's own units); rotate: degrees; scale: [sx, sy]; opacity: 0..1; fill / stroke: a colour. */
export type KeyValue = number | [number, number] | string;
export interface Keyframe {
  /** Seconds from the start. */
  time: number;
  value: KeyValue;
}
export interface KeyTrack {
  property: KeyProperty;
  keys: Keyframe[];
  easing: MotionEasing;
  /** The animation elements of the track. */
  ids: NodeId[];
}

export class KeyframeError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly code: "INVALID_COMMAND" | "BBOX_UNAVAILABLE" = "INVALID_COMMAND",
  ) {
    super(message);
  }
}

const TRANSFORM_KEYS: readonly string[] = ["translate", "rotate", "scale"];
export const isTransformKey = (p: string): boolean => TRANSFORM_KEYS.includes(p);

const f = formatNumber;
const SPLINES: Record<MotionEasing, string> = {
  linear: "0 0 1 1",
  ease: "0.25 0.1 0.25 1",
  easeIn: "0.42 0 1 1",
  easeOut: "0 0 0.58 1",
  easeInOut: "0.42 0 0.58 1",
};

/** Checks and normalizes one key's value for a property. */
export function keyValue(property: KeyProperty, v: unknown): KeyValue {
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const pair = (x: unknown) => Array.isArray(x) && x.length === 2 && x.every(num);
  switch (property) {
    case "translate":
      if (pair(v)) return [(v as number[])[0]!, (v as number[])[1]!];
      break;
    case "scale":
      if (num(v) && (v as number) !== 0) return [v as number, v as number];
      if (pair(v) && (v as number[]).every((n) => n !== 0)) return [(v as number[])[0]!, (v as number[])[1]!];
      break;
    case "rotate":
      if (num(v)) return v as number;
      break;
    case "opacity":
      if (num(v) && (v as number) >= 0 && (v as number) <= 1) return v as number;
      break;
    case "fill":
    case "stroke":
      if (typeof v === "string" && v.trim() && !/[;"<>]/.test(v)) return v.trim();
      break;
  }
  const want = {
    translate: "[dx, dy] in the element's units",
    scale: "a non-zero number or [sx, sy]",
    rotate: "degrees",
    opacity: "a number from 0 to 1",
    fill: "a colour",
    stroke: "a colour",
  }[property];
  throw new KeyframeError(`A ${property} keyframe value must be ${want}, got ${JSON.stringify(v)}.`, 'Example: { time: 1, value: [40, 0] } for translate, or { time: 0.5, value: "#4f46e5" } for fill.');
}

/** Sorted keys, one per time (the last given wins), with checked values. */
export function normalizeKeys(property: KeyProperty, raw: unknown): Keyframe[] {
  if (!Array.isArray(raw)) throw new KeyframeError('"keys" must be an array of { time, value }.', "Pass [] to remove the track.");
  const byTime = new Map<number, KeyValue>();
  for (const k of raw as { time?: unknown; value?: unknown }[]) {
    if (!k || typeof k.time !== "number" || !Number.isFinite(k.time) || k.time < 0 || k.time > 600) {
      throw new KeyframeError(`A keyframe time must be seconds from 0 to 600, got ${JSON.stringify(k?.time)}.`, "Example: { time: 1.5, value: 0.5 }.");
    }
    byTime.set(Math.round(k.time * 1000) / 1000, keyValue(property, k.value));
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
}

function text(property: KeyProperty, v: KeyValue, center: [number, number]): string {
  if (property === "rotate") return `${f(v as number)} ${f(center[0])} ${f(center[1])}`;
  if (Array.isArray(v)) return `${f(v[0])} ${f(v[1])}`;
  return typeof v === "number" ? f(v) : v;
}

/**
 * The SMIL elements of one track. Rotation and scale turn about `center` (the element's
 * own coordinates). A first key after 0 s is held from the start.
 */
export function buildTrack(property: KeyProperty, keys: Keyframe[], easing: MotionEasing, center: [number, number] | null): { tag: string; attrs: Record<string, string> }[] {
  if ((property === "rotate" || property === "scale") && !center) {
    throw new KeyframeError(`${property} keyframes turn about the element's centre, which cannot be measured here.`, "Pass box: { x, y, width, height } (the element's bounding box in its own coordinates).", "BBOX_UNAVAILABLE");
  }
  const c = center ?? [0, 0];
  const times = keys.map((k) => k.time);
  const values = keys.map((k) => text(property, k.value, c));
  if (times[0]! > 0 || times.length === 1) {
    times.unshift(0);
    values.unshift(values[0]!);
  }
  const dur = Math.max(times.at(-1)!, 0.001);
  const keyTimes = times.map((t, i) => (i === times.length - 1 ? 1 : Math.round((t / dur) * 10000) / 10000));
  const held = keys[0]!.time > 0 || keys.length === 1;
  const splines = keyTimes.slice(1).map((_, i) => (held && i === 0 ? SPLINES.linear : SPLINES[easing]));
  const common = (key: string, own: boolean): Record<string, string> => ({
    keyTimes: keyTimes.map(f).join(";"),
    ...(easing === "linear" ? {} : { calcMode: "spline", keySplines: splines.join(";") }),
    begin: "0s",
    dur: `${f(Math.round(dur * 1000) / 1000)}s`,
    fill: "freeze",
    "data-motion": "keys",
    "data-key": key,
    ...(own ? { "data-keys": keys.map((k) => f(k.time)).join(";"), "data-ease": easing } : {}),
  });
  const transform = (type: string, vals: string[], key: string, own: boolean) => ({
    tag: "animateTransform",
    attrs: { attributeName: "transform", type, values: vals.join(";"), ...common(key, own), additive: "sum" },
  });
  switch (property) {
    case "translate":
      return [transform("translate", values, "translate", true)];
    case "rotate":
      return [transform("rotate", values, "rotate", true)];
    case "scale": {
      const at = (x: number, y: number) => values.map(() => `${f(x)} ${f(y)}`);
      return [transform("translate", at(c[0], c[1]), "scale-origin", false), transform("scale", values, "scale", true), transform("translate", at(-c[0], -c[1]), "scale-origin", false)];
    }
    default:
      return [{ tag: "animate", attrs: { attributeName: property, values: values.join(";"), ...common(property, true) } }];
  }
}

/** The keyframe tracks among an element's children, read back from their attributes. */
export function readTracks(children: { id: NodeId; tag: string; attrs: Record<string, string> }[]): KeyTrack[] {
  const tracks: KeyTrack[] = [];
  for (const c of children) {
    const a = c.attrs;
    if (a["data-motion"] !== "keys") continue;
    const property = a["data-key"] as KeyProperty;
    if (!(KEY_PROPERTIES as readonly string[]).includes(property)) continue;
    const times = (a["data-keys"] ?? "").split(";").filter((s) => s.trim()).map(Number);
    const values = (a.values ?? "").split(";").map((s) => s.trim());
    const offset = values.length - times.length; // a held first value
    const keys = times.map((time, i) => ({ time, value: parseValue(property, values[i + offset] ?? "") }));
    const easing = (MOTION_EASINGS as readonly string[]).includes(a["data-ease"] ?? "") ? (a["data-ease"] as MotionEasing) : "linear";
    const ids = [c.id];
    if (property === "scale") {
      const i = children.indexOf(c);
      for (const n of [children[i - 1], children[i + 1]]) if (n?.attrs["data-key"] === "scale-origin") ids.push(n.id);
    }
    tracks.push({ property, keys, easing, ids });
  }
  return tracks;
}

function parseValue(property: KeyProperty, s: string): KeyValue {
  if (property === "fill" || property === "stroke") return s;
  const n = s.split(/[\s,]+/).map(Number);
  if (property === "rotate" || property === "opacity") return n[0] ?? 0;
  return [n[0] ?? 0, n[1] ?? n[0] ?? 0];
}

/** The centre a rotate / scale track turns about (its first value). */
export function trackCenter(children: { tag: string; attrs: Record<string, string> }[]): [number, number] | null {
  for (const c of children) {
    if (c.attrs["data-motion"] !== "keys") continue;
    const k = c.attrs["data-key"];
    if (k === "rotate") {
      const n = (c.attrs.values ?? "").split(";")[0]!.trim().split(/[\s,]+/).map(Number);
      if (n.length >= 3 && n.every(Number.isFinite)) return [n[1]!, n[2]!];
    }
    // The first scale-origin element (before the scale) translates by +centre.
    if (k === "scale-origin") {
      const n = (c.attrs.values ?? "").split(";")[0]!.trim().split(/[\s,]+/).map(Number);
      if (n.length >= 2 && n.every(Number.isFinite)) return [n[0]!, n[1]!];
    }
  }
  return null;
}

/** Progress (0..1) along a cubic-bezier easing for linear progress x. */
function ease(easing: MotionEasing, x: number): number {
  if (easing === "linear") return x;
  const [x1, y1, x2, y2] = SPLINES[easing].split(" ").map(Number) as [number, number, number, number];
  const bez = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bez(mid, x1, x2) < x) lo = mid;
    else hi = mid;
  }
  return bez((lo + hi) / 2, y1, y2);
}

/** The track's value at `t` seconds (colours step at keys). */
export function valueAt(track: Pick<KeyTrack, "keys" | "easing" | "property">, t: number): KeyValue {
  const k = track.keys;
  if (k.length === 0) throw new KeyframeError("The track has no keys.", "Add a keyframe first.");
  if (t <= k[0]!.time) return k[0]!.value;
  if (t >= k.at(-1)!.time) return k.at(-1)!.value;
  const i = k.findIndex((key) => key.time > t);
  const a = k[i - 1]!;
  const b = k[i]!;
  const p = ease(track.easing, (t - a.time) / (b.time - a.time));
  const mix = (x: number, y: number) => Math.round((x + (y - x) * p) * 1e6) / 1e6;
  if (typeof a.value === "number" && typeof b.value === "number") return mix(a.value, b.value);
  if (Array.isArray(a.value) && Array.isArray(b.value)) return [mix(a.value[0], b.value[0]), mix(a.value[1], b.value[1])];
  return p < 1 ? a.value : b.value;
}

/** Centre of a box, rounded to 2 decimals. */
export function boxCenter(b: BBox): [number, number] {
  return [Math.round((b.x + b.width / 2) * 100) / 100, Math.round((b.y + b.height / 2) * 100) / 100];
}
