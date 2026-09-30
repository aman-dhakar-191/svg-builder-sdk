export { createEditor, DocumentApi, Editor, EMPTY_SVG, LockSession } from "./editor.js";
export type { AttrValue, Bridges, CreateEditorOptions, ExecuteResult, LockInfo, LockOptions, LockOutcome, Measurer, Rasterizer, Rect, TextChangeEvent, TransformOptions } from "./editor.js";
export { SvgEditorError, type SdkErrorCode } from "./errors.js";
export { TEXT_TAG } from "@svg-editor/model";
export type { BBox, Command, CommandError, CommandResult, NodeData, NodeId, Query, TreeNode, Vec2 } from "@svg-editor/model";
export type { TextEdit } from "@svg-editor/parser";
export type { AbortSignalLike } from "./platform.js";
