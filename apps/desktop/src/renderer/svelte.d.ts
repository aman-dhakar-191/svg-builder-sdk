/// <reference types="svelte" />
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component<Record<string, unknown>>;
  export default component;
}

/** Stylesheets imported for their side effect (bundled by Vite). */
declare module "*.css";
