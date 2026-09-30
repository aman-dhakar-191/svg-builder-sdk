export { lineColumn, parseSvg } from "./parse.js";
export type { ParsedAttr, ParsedElement, ParsedNode, ParsedText, ParseError, ParseErrorCode, ParseResult } from "./parse.js";
export { reconcile, type ReconcileResult } from "./reconcile.js";
export { applyEdits, openSvg, SourceDocument } from "./source-document.js";
export type { OpenResult, TextChange, TextEdit } from "./source-document.js";
export { toInputTree } from "./source-map.js";
