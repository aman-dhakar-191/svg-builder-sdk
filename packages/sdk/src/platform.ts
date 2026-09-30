/**
 * Timers and AbortController exist in every runtime we target (Node, Electron,
 * browsers), but the SDK compiles without DOM or Node type definitions to stay
 * platform-neutral. These are the few members it uses.
 */

/** The platform AbortSignal (pass it to fetch() to cancel a request). */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(reason?: unknown): void;
}

const g = globalThis as unknown as {
  AbortController: new () => AbortControllerLike;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const newAbortController = (): AbortControllerLike => new g.AbortController();
export const startTimer = (fn: () => void, ms: number): unknown => g.setTimeout(fn, ms);
export const stopTimer = (handle: unknown): void => g.clearTimeout(handle);
