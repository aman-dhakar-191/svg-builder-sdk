/**
 * The part of a streamed, unfinished JSON object that is already complete: the
 * text is cut after the last finished object or array, and the brackets still
 * open are closed. `{"elements":[{"tag":"rect"},{"tag":"ci` gives
 * `{ elements: [{ tag: "rect" }] }`. Undefined when nothing is complete yet.
 */
export function completedPrefix(json: string): unknown {
  const open: string[] = [];
  let inString = false;
  let escaped = false;
  let cut = -1;
  let closersAtCut = "";
  for (let i = 0; i < json.length; i++) {
    const c = json[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") open.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      open.pop();
      // A value just closed inside an array: a safe place to cut.
      if (open.at(-1) === "]" || open.length === 0) {
        cut = i + 1;
        closersAtCut = [...open].reverse().join("");
      }
    }
  }
  if (cut < 0) return undefined;
  try {
    return JSON.parse(json.slice(0, cut) + closersAtCut);
  } catch {
    return undefined;
  }
}

/** Calls `fn` at most every `ms` (the first call at once, the last one after the wait); `cancel` drops a pending call. */
export function throttle<A extends unknown[]>(ms: number, fn: (...args: A) => void): { call: (...args: A) => void; cancel: () => void } {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;
  return {
    call: (...args: A) => {
      pending = args;
      const wait = last + ms - Date.now();
      if (wait <= 0 && !timer) {
        last = Date.now();
        pending = undefined;
        fn(...args);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          last = Date.now();
          const p = pending;
          pending = undefined;
          if (p) fn(...p);
        }, Math.max(0, wait));
      }
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
