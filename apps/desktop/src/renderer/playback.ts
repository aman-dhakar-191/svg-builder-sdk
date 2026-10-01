import { parseClock } from "@svg-editor/sdk";

const ANIMATIONS = "animate, animateTransform, animateMotion, set";

/**
 * SMIL playback on the canvas. The canvas is for editing, so between previews
 * it rests paused at the end of the timeline: entrances in their final state,
 * loops at their start pose. Animations that start on click or hover are
 * disarmed there (a click selects, it does not play); a preview starts them
 * at their delay instead, so they can be seen too.
 */
export class Playback {
  private svg: SVGSVGElement | null = null;
  /** Click / hover animations of the current canvas DOM and their delays. */
  private triggered: { el: SVGAnimationElement; delay: number }[] = [];
  private frame = 0;
  private _playing = false;
  private _time: number | null = null;

  /** Told on every frame while playing, and when playback stops or seeks (time null = at rest). */
  onChange: (state: { playing: boolean; time: number | null }) => void = () => {};

  /** The preview's length: when everything (triggered ones from their delay) has played once. */
  end = 0;

  get playing(): boolean {
    return this._playing;
  }

  /** Seconds into the preview, or null at rest. */
  get time(): number | null {
    return this._time;
  }

  /** A freshly rendered canvas: disarm triggers, rest at the end. Called after every render. */
  attach(svg: SVGSVGElement): void {
    this.stopFrames();
    this.svg = svg;
    this.triggered = [];
    for (const el of Array.from(svg.querySelectorAll<SVGAnimationElement>(ANIMATIONS))) {
      const begin = (el.getAttribute("begin") ?? "").split(";")[0]!.trim();
      if (begin === "" || parseClock(begin) !== null) continue;
      const m = /\+\s*(.+)$/.exec(begin);
      this.triggered.push({ el, delay: m ? (parseClock(m[1]!) ?? 0) : 0 });
      el.setAttribute("begin", "indefinite");
      el.removeAttribute("end");
    }
    this.rest();
  }

  /** Paused at the end of the timeline (the editing state). */
  rest(): void {
    this.stopFrames();
    this._playing = false;
    this._time = null;
    // Just past the end: entrances are frozen at their final value, loops (practically) at their start.
    this.seekDom(this.end + 1e-6, false);
    this.onChange({ playing: false, time: null });
  }

  play(): void {
    const svg = this.svg;
    if (!svg) return;
    const from = this._time === null || this._time >= this.end ? 0 : this._time;
    this.seekDom(from, true);
    svg.unpauseAnimations();
    this._playing = true;
    const tick = () => {
      const t = svg.getCurrentTime();
      // Played through: back to the resting drawing, where editing happens.
      if (t >= this.end) return this.rest();
      this._time = t;
      this.onChange({ playing: true, time: t });
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  pause(): void {
    if (!this._playing) return;
    this.stopFrames();
    this.svg?.pauseAnimations();
    this._playing = false;
    this._time = this.svg?.getCurrentTime() ?? null;
    this.onChange({ playing: false, time: this._time });
  }

  /** Shows the frame at `t` seconds, paused. */
  seek(t: number): void {
    this.stopFrames();
    this._playing = false;
    this._time = Math.max(0, Math.min(this.end, t));
    this.seekDom(this._time, true);
    this.onChange({ playing: false, time: this._time });
  }

  private seekDom(t: number, armTriggers: boolean): void {
    const svg = this.svg;
    if (!svg) return;
    svg.pauseAnimations();
    // Triggered animations restart from their delay; at rest they stay unstarted.
    for (const { el } of this.triggered) {
      try {
        el.endElement();
      } catch {
        // not active
      }
    }
    svg.setCurrentTime(0);
    if (armTriggers) for (const { el, delay } of this.triggered) el.beginElementAt(delay);
    svg.setCurrentTime(t);
  }

  private stopFrames(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}
