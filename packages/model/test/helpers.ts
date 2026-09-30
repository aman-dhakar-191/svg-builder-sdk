import { expect } from "vitest";
import type { Command, CommandError, CommandResult, CommandResultMap, SvgDocument } from "../src/index.js";

export function ok<T>(r: CommandResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.result;
}

export function err(r: CommandResult<unknown>): CommandError {
  if (r.ok) throw new Error(`expected an error, got ok: ${JSON.stringify(r.result)}`);
  expect(r.error.message.length).toBeGreaterThan(0);
  expect(r.error.hint.length).toBeGreaterThan(0);
  return r.error;
}

/** Full observable state: tree with IDs plus serialized text. */
export function snapshot(doc: SvgDocument) {
  return { tree: doc.getTree(), svg: doc.toSvg() };
}

/**
 * Executes `cmd`, then checks undo restores the exact prior state and redo
 * restores the exact post state (same IDs), twice over.
 */
export function expectRoundTrip<C extends Command>(doc: SvgDocument, cmd: C): CommandResultMap[C["op"]] {
  const before = snapshot(doc);
  const result = ok(doc.execute(cmd));
  const after = snapshot(doc);
  expect(after).not.toEqual(before);
  for (let i = 0; i < 2; i++) {
    expect(doc.undo()).toBe(true);
    expect(snapshot(doc)).toEqual(before);
    expect(doc.redo()).toBe(true);
    expect(snapshot(doc)).toEqual(after);
  }
  return result;
}

/** A failed command must leave no trace: same state, same history depth. */
export function expectNoChange(doc: SvgDocument, cmd: unknown): CommandError {
  const before = snapshot(doc);
  const canUndo = doc.canUndo();
  const e = err(doc.execute(cmd));
  expect(snapshot(doc)).toEqual(before);
  expect(doc.canUndo()).toBe(canUndo);
  return e;
}
