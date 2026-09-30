import { createRequire } from "node:module";

/**
 * Electron fetches its binary on first use, not at install. Two Playwright workers
 * launching at once on a fresh machine then race: one is still writing the binary while
 * the other runs it (spawn ETXTBSY). Resolving it here, once, before any worker starts,
 * downloads it first.
 */
export default function globalSetup(): void {
  const path = createRequire(import.meta.url)("electron") as unknown as string;
  if (typeof path !== "string" || !path) throw new Error("Electron binary not available");
}
