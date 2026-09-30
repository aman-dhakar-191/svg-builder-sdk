// Svelte's transitions run through the Web Animations API, which the CSS reduced-motion rule in app.css
// does not reach. Components import fade/fly/slide from here instead, so "reduce motion" turns them off.
import * as t from "svelte/transition";

const query = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
export const reducedMotion = (): boolean => query?.matches ?? false;

function calm<P extends { duration?: number; delay?: number }>(fn: (node: Element, params?: P) => t.TransitionConfig) {
  return (node: Element, params?: P): t.TransitionConfig => (reducedMotion() ? fn(node, { ...params, duration: 0, delay: 0 } as P) : fn(node, params));
}

export const fade = calm(t.fade);
export const fly = calm(t.fly);
export const slide = calm(t.slide);
