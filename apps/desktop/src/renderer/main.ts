import "@fontsource/onest/400.css";
import "@fontsource/onest/500.css";
import "@fontsource/onest/600.css";
import "@fontsource/onest/700.css";
import "@fontsource/fragment-mono/400.css";
import "./styles/app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { session } from "./lib/session.svelte.js";

mount(App, { target: document.getElementById("app")! });

// Exposed for end-to-end tests and debugging only.
Object.defineProperty(window, "editor", {
  get: () => ({ editor: session.editor, view: session.view, flush: session.flush, canvas: session.canvas, viewport: session.viewport, menu: session.actions, session }),
});
