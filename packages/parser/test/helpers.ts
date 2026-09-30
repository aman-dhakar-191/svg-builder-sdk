import { expect } from "vitest";
import type { CommandResult } from "@svg-editor/model";
import { openSvg, type SourceDocument, type TextChange } from "../src/index.js";

export function open(text: string): SourceDocument & { changes: TextChange[] } {
  const r = openSvg(text);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  const changes: TextChange[] = [];
  r.source.onChange((c) => changes.push(c));
  return Object.assign(r.source, { changes });
}

export function ok<T>(r: CommandResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.result;
}

/** Node id of the first element matching tag (+ optional attrs). */
export function find(s: SourceDocument, tag: string, attr?: Record<string, string>): string {
  const id = s.doc.query({ tag, ...(attr ? { attr } : {}) })[0];
  if (!id) throw new Error(`no <${tag}> ${JSON.stringify(attr)}`);
  return id;
}

/** Everything patched minimally, and undo restores the original bytes. */
export function expectCleanUndo(s: SourceDocument, original: string) {
  expect(s.fallbacks).toBe(0);
  while (s.doc.undo());
  expect(s.text).toBe(original);
  expect(s.fallbacks).toBe(0);
}
