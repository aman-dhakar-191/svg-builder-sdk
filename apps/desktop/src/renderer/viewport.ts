import { fitZoom, invert, mat, nextZoom, niceStep, snapPoint, apply, type Point } from "./geometry.js";

const MIN_GRID_PX = 12;

/**
 * Zoom, pan, grid and snapping for the canvas. The drawing is sized with CSS
 * (width/height = intrinsic size x zoom); panning scrolls the canvas host.
 * Hit-testing and gestures use getScreenCTM, which already includes both.
 */
export class Viewport {
  private _zoom = 1;
  private _grid = false;
  private _snap = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly gridLayer: SVGSVGElement,
    private readonly onChange: () => void,
  ) {
    host.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    host.addEventListener("scroll", () => this.drawGrid());
    new ResizeObserver(() => this.drawGrid()).observe(host);
  }

  get zoom(): number {
    return this._zoom;
  }
  get grid(): boolean {
    return this._grid;
  }
  get snapping(): boolean {
    return this._snap;
  }

  private svg(): SVGSVGElement | null {
    return this.host.querySelector(":scope > svg");
  }

  /** The drawing's size at 100%: width/height in absolute units, else the viewBox, else 300x150. */
  intrinsicSize(): { width: number; height: number } {
    const svg = this.svg();
    if (!svg) return { width: 300, height: 150 };
    const vb = svg.viewBox.baseVal;
    const len = (l: SVGAnimatedLength, fallback: number) => {
      const has = svg.hasAttribute(l === svg.width ? "width" : "height");
      if (!has || l.baseVal.unitType === SVGLength.SVG_LENGTHTYPE_PERCENTAGE) return fallback;
      try {
        return l.baseVal.value;
      } catch {
        return fallback;
      }
    };
    const vbw = vb && vb.width > 0 ? vb.width : 0;
    const vbh = vb && vb.height > 0 ? vb.height : 0;
    let width = len(svg.width, vbw || 300);
    let height = len(svg.height, vbh || 150);
    // Only one dimension given: keep the viewBox aspect ratio.
    if (vbw && vbh && svg.hasAttribute("width") && !svg.hasAttribute("height")) height = (width * vbh) / vbw;
    if (vbw && vbh && svg.hasAttribute("height") && !svg.hasAttribute("width")) width = (height * vbw) / vbh;
    return { width, height };
  }

  /** Re-applies the size after each render (the SVG element is rebuilt). */
  apply(): void {
    const svg = this.svg();
    if (!svg) return;
    const { width, height } = this.intrinsicSize();
    svg.style.width = `${width * this._zoom}px`;
    svg.style.height = `${height * this._zoom}px`;
    this.drawGrid();
  }

  setZoom(zoom: number, anchor?: Point): void {
    const z = Math.max(0.05, Math.min(zoom, 32));
    const before = anchor ? this.toRoot(anchor) : null;
    this._zoom = z;
    this.apply();
    if (anchor && before) {
      // Keep the point under the cursor in place.
      const after = this.toScreen(before);
      this.host.scrollLeft += after.x - anchor.x;
      this.host.scrollTop += after.y - anchor.y;
    }
    this.onChange();
  }

  zoomIn(): void {
    this.setZoom(nextZoom(this._zoom, 1));
  }
  zoomOut(): void {
    this.setZoom(nextZoom(this._zoom, -1));
  }
  fit(): void {
    const box = this.host.getBoundingClientRect();
    this.setZoom(fitZoom(this.intrinsicSize(), { width: box.width, height: box.height }));
  }

  toggleGrid(): void {
    this._grid = !this._grid;
    this.drawGrid();
    this.onChange();
  }
  toggleSnap(): void {
    this._snap = !this._snap;
    this.onChange();
  }

  /** Grid spacing in root user units: a nice number at least MIN_GRID_PX on screen. */
  gridStep(): number {
    const ctm = this.svg()?.getScreenCTM();
    const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
    return niceStep(MIN_GRID_PX / (scale || 1));
  }

  /** Snaps a point in root user units, when snapping is on. */
  snapRoot(p: Point): Point {
    return this._snap ? snapPoint(p, this.gridStep()) : p;
  }

  toRoot(p: Point): Point {
    const ctm = this.svg()?.getScreenCTM();
    return ctm ? apply(invert(mat(ctm)), p) : p;
  }

  toScreen(p: Point): Point {
    const ctm = this.svg()?.getScreenCTM();
    return ctm ? apply(mat(ctm), p) : p;
  }

  private wheel(e: WheelEvent): void {
    if (!(e.ctrlKey || e.metaKey)) return; // plain wheel scrolls (pans)
    e.preventDefault();
    this.setZoom(this._zoom * Math.exp(-e.deltaY * 0.002), { x: e.clientX, y: e.clientY });
  }

  /**
   * Redraws the layer above the drawing: a dimming mask outside the page (the
   * drawing shows overflow so off-page shapes stay visible and grabbable, but
   * export crops to the page) and, when on, the grid.
   */
  drawGrid(): void {
    const g = this.gridLayer;
    g.replaceChildren();
    const svg = this.svg();
    if (!svg) return;
    const origin = g.getBoundingClientRect();
    const page = svg.getBoundingClientRect();
    const mask = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const px = page.left - origin.left;
    const py = page.top - origin.top;
    mask.setAttribute("d", `M0 0H${origin.width}V${origin.height}H0Z M${px} ${py}h${page.width}v${page.height}h${-page.width}Z`);
    mask.setAttribute("fill-rule", "evenodd");
    mask.setAttribute("class", "off-page");
    g.appendChild(mask);
    if (!this._grid) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const step = this.gridStep();
    const { width, height } = this.intrinsicSize();
    const vb = svg.viewBox.baseVal;
    const x0 = vb && vb.width > 0 ? vb.x : 0;
    const y0 = vb && vb.height > 0 ? vb.y : 0;
    const w = vb && vb.width > 0 ? vb.width : width;
    const h = vb && vb.height > 0 ? vb.height : height;
    const m = mat(ctm);
    const parts: string[] = [];
    const push = (a: Point, b: Point) => {
      const p = apply(m, a);
      const q = apply(m, b);
      parts.push(`M${p.x - origin.left} ${p.y - origin.top}L${q.x - origin.left} ${q.y - origin.top}`);
    };
    for (let x = Math.ceil(x0 / step) * step, n = 0; x <= x0 + w + 1e-9 && n < 2000; x += step, n++) push({ x, y: y0 }, { x, y: y0 + h });
    for (let y = Math.ceil(y0 / step) * step, n = 0; y <= y0 + h + 1e-9 && n < 2000; y += step, n++) push({ x: x0, y }, { x: x0 + w, y });
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", parts.join(""));
    path.setAttribute("class", "grid-lines");
    g.appendChild(path);
  }
}
