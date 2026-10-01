import { formatNumber } from "./geometry.js";
import type { BBox } from "./types.js";

/**
 * Motion is stored as SMIL: <animate>, <animateTransform>, <animateMotion> and
 * <set> children of the element they animate. Presets tag what they add with
 * data-motion="<preset>" so they can be found, replaced and removed again;
 * hand-written animations have no tag and are kept as they are.
 */
export const ANIMATION_TAGS: ReadonlySet<string> = new Set(["animate", "animateTransform", "animateMotion", "set"]);

export const MOTION_PRESETS = ["fadeIn", "slideIn", "popIn", "drawOn", "spin", "pulse", "float", "wiggle"] as const;
export type MotionPreset = (typeof MOTION_PRESETS)[number];
export type MotionTrigger = "load" | "click" | "hover";
export const MOTION_EASINGS = ["linear", "ease", "easeIn", "easeOut", "easeInOut"] as const;
export type MotionEasing = (typeof MOTION_EASINGS)[number];

export interface MotionOptions {
  /** Seconds for one run, without the delay. */
  duration?: number;
  /** Seconds before it starts (after the trigger). */
  delay?: number;
  /** How many runs, or "indefinite". Entrances default to 1, loops to "indefinite". */
  repeat?: number | "indefinite";
  /** When it starts: when the drawing loads (default), on click, or on hover. */
  trigger?: MotionTrigger;
  easing?: MotionEasing;
  /** slideIn: the side it enters from (default "bottom"). */
  from?: "left" | "right" | "top" | "bottom";
  /** slideIn and float: how far it travels, in the element's units. */
  distance?: number;
  /** spin: direction (default true). */
  clockwise?: boolean;
}

export interface PresetInfo {
  /** Entrances play once and keep their end state; loops repeat. */
  kind: "entrance" | "loop";
  label: string;
  duration: number;
  easing: MotionEasing;
}

export const PRESET_INFO: Record<MotionPreset, PresetInfo> = {
  fadeIn: { kind: "entrance", label: "Fade in", duration: 0.6, easing: "easeOut" },
  slideIn: { kind: "entrance", label: "Slide in", duration: 0.6, easing: "easeOut" },
  popIn: { kind: "entrance", label: "Pop in", duration: 0.5, easing: "easeOut" },
  drawOn: { kind: "entrance", label: "Draw on", duration: 1.5, easing: "easeInOut" },
  spin: { kind: "loop", label: "Spin", duration: 2, easing: "linear" },
  pulse: { kind: "loop", label: "Pulse", duration: 1, easing: "easeInOut" },
  float: { kind: "loop", label: "Float", duration: 2, easing: "easeInOut" },
  wiggle: { kind: "loop", label: "Wiggle", duration: 0.8, easing: "easeInOut" },
};

const SPLINES: Record<MotionEasing, string> = {
  linear: "0 0 1 1",
  ease: "0.25 0.1 0.25 1",
  easeIn: "0.42 0 1 1",
  easeOut: "0 0 0.58 1",
  easeInOut: "0.42 0 0.58 1",
};

/** Shapes whose stroke can be drawn on (they take pathLength). */
export const DRAWABLE_TAGS: ReadonlySet<string> = new Set(["path", "line", "polyline", "polygon", "rect", "circle", "ellipse"]);

/** What a preset needs to know about its target. */
export interface MotionTarget {
  tag: string;
  attrs: Record<string, string>;
  /** Bounding box in the element's own coordinates; null when unknown. */
  box: BBox | null;
  /** Effective stroke and fill (inherited ones included), null when not set anywhere. */
  stroke: string | null;
  fill: string | null;
}

export interface BuiltMotion {
  elements: { tag: string; attrs: Record<string, string> }[];
  /** Attributes the preset sets on the target itself (drawOn: pathLength). */
  targetAttrs: Record<string, string>;
}

/** Thrown by buildMotion when a preset cannot apply to the target; carries a hint. */
export class MotionError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly code: "INVALID_COMMAND" | "NOT_ANIMATABLE" | "BBOX_UNAVAILABLE" = "NOT_ANIMATABLE",
  ) {
    super(message);
  }
}

const f = formatNumber;
const secs = (n: number) => `${f(Math.round(n * 1000) / 1000)}s`;

function check(o: MotionOptions): void {
  const bad = (field: string, want: string, got: unknown) => {
    throw new MotionError(`"${field}" must be ${want}, got ${JSON.stringify(got)}.`, `Example: { duration: 0.6, delay: 0.2, repeat: "indefinite" }.`, "INVALID_COMMAND");
  };
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (o.duration !== undefined && !(num(o.duration) && o.duration > 0 && o.duration <= 600)) bad("duration", "seconds between 0 and 600", o.duration);
  if (o.delay !== undefined && !(num(o.delay) && o.delay >= 0 && o.delay <= 600)) bad("delay", "seconds from 0 to 600", o.delay);
  if (o.repeat !== undefined && o.repeat !== "indefinite" && !(num(o.repeat) && o.repeat > 0)) bad("repeat", 'a positive number or "indefinite"', o.repeat);
  if (o.trigger !== undefined && !["load", "click", "hover"].includes(o.trigger)) bad("trigger", '"load", "click" or "hover"', o.trigger);
  if (o.easing !== undefined && !(MOTION_EASINGS as readonly string[]).includes(o.easing)) bad("easing", MOTION_EASINGS.map((e) => `"${e}"`).join(", "), o.easing);
  if (o.from !== undefined && !["left", "right", "top", "bottom"].includes(o.from)) bad("from", '"left", "right", "top" or "bottom"', o.from);
  if (o.distance !== undefined && !(num(o.distance) && o.distance > 0)) bad("distance", "a positive number", o.distance);
  if (o.clockwise !== undefined && typeof o.clockwise !== "boolean") bad("clockwise", "a boolean", o.clockwise);
}

/** One animated attribute: its values over one run and when each is reached (0..1). */
interface Track {
  tag: "animate" | "animateTransform";
  attrs: Record<string, string>;
  values: string[];
  times?: number[];
  /** Constant tracks (the translate around a centred scale) need no easing. */
  linear?: boolean;
}

/** SMIL timing for one track. A load delay is held inside the run, so entrances stay hidden from t=0. */
function timed(t: Track, preset: MotionPreset, o: Required<Pick<MotionOptions, "duration" | "delay" | "trigger" | "easing">> & { repeat: number | "indefinite" }): Record<string, string> {
  const kind = PRESET_INFO[preset].kind;
  let values = t.values;
  let times = t.times ?? values.map((_, i) => i / (values.length - 1));
  const easing = t.linear ? "linear" : o.easing;
  let splines = times.slice(1).map(() => SPLINES[easing]);
  let begin: string;
  let dur = o.duration;
  if (o.trigger === "load") {
    if (kind === "entrance" && o.delay > 0) {
      const total = o.delay + o.duration;
      values = [values[0]!, ...values];
      times = [0, ...times.map((k) => (o.delay + k * o.duration) / total)];
      splines = [SPLINES.linear, ...splines];
      begin = "0s";
      dur = total;
    } else {
      begin = secs(o.delay);
    }
  } else {
    const event = o.trigger === "click" ? "click" : "mouseover";
    begin = o.delay > 0 ? `${event}+${secs(o.delay)}` : event;
  }
  const even = times.every((k, i) => Math.abs(k - i / (times.length - 1)) < 1e-9);
  const curved = splines.some((s) => s !== SPLINES.linear);
  const a: Record<string, string> = { ...t.attrs, values: values.join(";") };
  if (!even || curved) a.keyTimes = times.map((k) => f(Math.round(k * 10000) / 10000)).join(";");
  if (curved) {
    a.calcMode = "spline";
    a.keySplines = splines.join(";");
  }
  a.begin = begin;
  a.dur = secs(dur);
  if (o.repeat !== 1) a.repeatCount = o.repeat === "indefinite" ? "indefinite" : f(o.repeat);
  if (kind === "entrance") a.fill = "freeze";
  if (t.tag === "animateTransform") a.additive = "sum";
  if (kind === "loop" && o.trigger === "hover") a.end = "mouseout";
  a["data-motion"] = preset;
  return a;
}

const transformTrack = (type: "translate" | "scale" | "rotate", values: string[], times?: number[], linear?: boolean): Track => ({
  tag: "animateTransform",
  attrs: { attributeName: "transform", type },
  values,
  ...(times ? { times } : {}),
  ...(linear ? { linear } : {}),
});

/** A scale around the centre: translate(c) scale translate(-c), each additive, in one run. */
function centredScale(c: [number, number], values: string[], times?: number[]): Track[] {
  const at = (x: number, y: number) => values.map(() => `${f(x)} ${f(y)}`);
  return [
    transformTrack("translate", at(c[0], c[1]), times, true),
    transformTrack("scale", values, times),
    transformTrack("translate", at(-c[0], -c[1]), times, true),
  ];
}

function centreOf(preset: MotionPreset, t: MotionTarget): [number, number] {
  if (!t.box) {
    throw new MotionError(`${preset} needs the centre of the <${t.tag}>, which cannot be measured here.`, "Pass box: { x, y, width, height } (the element's bounding box in its own coordinates).", "BBOX_UNAVAILABLE");
  }
  return [Math.round((t.box.x + t.box.width / 2) * 100) / 100, Math.round((t.box.y + t.box.height / 2) * 100) / 100];
}

const isNone = (v: string | null) => v === null || v.trim() === "none" || v.trim() === "transparent";

/** The SMIL elements (and target attributes) for one preset on one element. */
export function buildMotion(preset: MotionPreset, options: MotionOptions, target: MotionTarget): BuiltMotion {
  if (!(MOTION_PRESETS as readonly string[]).includes(preset)) {
    throw new MotionError(`Unknown preset ${JSON.stringify(preset)}.`, `Presets: ${MOTION_PRESETS.join(", ")}.`, "INVALID_COMMAND");
  }
  check(options);
  const info = PRESET_INFO[preset];
  const o = {
    duration: options.duration ?? info.duration,
    delay: options.delay ?? 0,
    trigger: options.trigger ?? "load",
    easing: options.easing ?? info.easing,
    repeat: options.repeat ?? (info.kind === "loop" ? ("indefinite" as const) : 1),
  };
  const size = target.box ? Math.max(target.box.width, target.box.height) : 0;
  const targetAttrs: Record<string, string> = {};
  let tracks: Track[];
  switch (preset) {
    case "fadeIn":
      tracks = [{ tag: "animate", attrs: { attributeName: "opacity" }, values: ["0", target.attrs.opacity ?? "1"] }];
      break;
    case "slideIn": {
      const d = options.distance ?? (size > 0 ? Math.round(size * 0.5 * 100) / 100 : 40);
      const from = options.from ?? "bottom";
      const start = { left: [-d, 0], right: [d, 0], top: [0, -d], bottom: [0, d] }[from];
      tracks = [transformTrack("translate", [`${f(start[0]!)} ${f(start[1]!)}`, "0 0"])];
      break;
    }
    case "popIn":
      tracks = centredScale(centreOf(preset, target), ["0", "1.1", "1"], [0, 0.7, 1]);
      break;
    case "pulse":
      tracks = centredScale(centreOf(preset, target), ["1", "1.08", "1"]);
      break;
    case "spin": {
      const [cx, cy] = centreOf(preset, target);
      const turn = options.clockwise === false ? -360 : 360;
      tracks = [transformTrack("rotate", [`0 ${f(cx)} ${f(cy)}`, `${turn} ${f(cx)} ${f(cy)}`])];
      break;
    }
    case "wiggle": {
      const [cx, cy] = centreOf(preset, target);
      tracks = [transformTrack("rotate", [0, -6, 6, -6, 6, 0].map((a) => `${a} ${f(cx)} ${f(cy)}`))];
      break;
    }
    case "float": {
      const h = target.box?.height ?? 0;
      const d = options.distance ?? (h > 0 ? Math.max(2, Math.round(h * 0.1 * 100) / 100) : 6);
      tracks = [transformTrack("translate", ["0 0", `0 ${f(-d)}`, "0 0"])];
      break;
    }
    case "drawOn": {
      if (!DRAWABLE_TAGS.has(target.tag)) {
        throw new MotionError(`drawOn works on shapes with a stroke, not on <${target.tag}>.`, "Use it on a path, line, polyline, polygon, rect, circle or ellipse; for text or groups use fadeIn.");
      }
      if (isNone(target.stroke)) {
        throw new MotionError(`drawOn draws the stroke, and this <${target.tag}> has none.`, 'Give it a stroke first, e.g. set attrs: { stroke: "#4f46e5", "stroke-width": "2" }.');
      }
      const dash = target.attrs["stroke-dasharray"];
      if (dash !== undefined && dash.trim() !== "none") {
        throw new MotionError(`drawOn uses the stroke's dashes, and this <${target.tag}> is already dashed.`, 'Remove its stroke-dasharray first, or use fadeIn.');
      }
      const pl = target.attrs.pathLength;
      if (pl !== undefined && pl !== "1") {
        throw new MotionError(`drawOn sets pathLength="1", and this <${target.tag}> has pathLength="${pl}".`, "Remove its pathLength first.");
      }
      targetAttrs.pathLength = "1";
      tracks = [
        { tag: "animate", attrs: { attributeName: "stroke-dasharray" }, values: ["1", "1"], linear: true },
        { tag: "animate", attrs: { attributeName: "stroke-dashoffset" }, values: ["1", "0"] },
      ];
      // A filled shape: the fill comes in at the end of the stroke.
      const fill = target.fill ?? "black";
      if (!isNone(fill)) {
        const fo = target.attrs["fill-opacity"] ?? "1";
        tracks.push({ tag: "animate", attrs: { attributeName: "fill-opacity" }, values: ["0", "0", fo], times: [0, 0.6, 1] });
      }
      break;
    }
  }
  return { elements: tracks.map((t) => ({ tag: t.tag, attrs: timed(t, preset, o) })), targetAttrs };
}

// ------------------------------------------------------------------ reading

/** Seconds of a SMIL clock value ("2s", "500ms", "1.5", "00:01:02.5", "1min", "1h"); null if it is not one. */
export function parseClock(value: string | undefined): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  const unit = /^(\d+(?:\.\d+)?|\.\d+)(h|min|s|ms)?$/.exec(v);
  if (unit) {
    const n = Number(unit[1]);
    return unit[2] === "h" ? n * 3600 : unit[2] === "min" ? n * 60 : unit[2] === "ms" ? n / 1000 : n;
  }
  const clock = /^(?:(\d+):)?(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(v);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  return null;
}

export interface AnimationInfo {
  /** The data-motion tag, or null for a hand-written animation. */
  preset: string | null;
  /** The animated attribute ("transform", "opacity", …; "motion" for animateMotion). */
  attribute: string | null;
  /** "load" (on the timeline), "click", "hover", or "event" for any other begin. */
  trigger: MotionTrigger | "event";
  /** Seconds after the trigger. For a preset with a held delay, the delay inside the run. */
  delay: number;
  /** Seconds of one run, without that delay; null when not set ("indefinite" or missing). */
  duration: number | null;
  repeat: number | "indefinite";
}

/** What one animation element does, read back from its attributes. */
export function readAnimation(tag: string, a: Record<string, string>): AnimationInfo {
  const first = (a.begin ?? "0s").split(";")[0]!.trim();
  let trigger: AnimationInfo["trigger"] = "event";
  let delay = 0;
  const at = parseClock(first);
  if (at !== null) {
    trigger = "load";
    delay = at;
  } else {
    const m = /^(click|mouseover)(?:\s*\+\s*(.+))?$/.exec(first);
    if (m) {
      trigger = m[1] === "click" ? "click" : "hover";
      delay = m[2] ? (parseClock(m[2]) ?? 0) : 0;
    }
  }
  let duration = parseClock(a.dur);
  // A preset entrance with a load delay holds its first value until keyTimes[1].
  const values = a.values?.split(";").map((s) => s.trim());
  const times = values && (a.keyTimes?.split(";").map(Number) ?? values.map((_, i) => i / (values.length - 1)));
  if (a["data-motion"] && trigger === "load" && delay === 0 && duration !== null && values && times && values.length > 2 && values[0] === values[1] && times[1]! > 0 && a.fill === "freeze") {
    delay = Math.round(times[1]! * duration * 1000) / 1000;
    duration = Math.round((duration - delay) * 1000) / 1000;
  }
  const rc = a.repeatCount?.trim();
  const repeat = rc === "indefinite" || a.repeatDur?.trim() === "indefinite" ? "indefinite" : rc && Number(rc) > 0 ? Number(rc) : 1;
  return {
    preset: a["data-motion"] ?? null,
    attribute: a.attributeName ?? (tag === "animateMotion" ? "motion" : null),
    trigger,
    delay,
    duration,
    repeat,
  };
}

/**
 * When everything on the timeline (load-triggered) has finished one pass:
 * the latest start + run length, counting a loop once. 0 without animations.
 */
export function timelineEnd(infos: AnimationInfo[]): number {
  let end = 0;
  for (const i of infos) {
    if (i.trigger !== "load" || i.duration === null) continue;
    const runs = i.repeat === "indefinite" ? 1 : i.repeat;
    end = Math.max(end, i.delay + i.duration * runs);
  }
  return Math.round(end * 1000) / 1000;
}
