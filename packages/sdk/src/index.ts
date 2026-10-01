export { createEditor, DocumentApi, Editor, EMPTY_SVG, LockSession } from "./editor.js";
export type { AnimateOptions, AnimationEntry, AttrValue, Bridges, CreateEditorOptions, ExecuteResult, ExportPngOptions, LockInfo, LockOptions, LockOutcome, Measurer, Rasterizer, Rect, TextChangeEvent, TransformOptions } from "./editor.js";
export { SvgEditorError, type SdkErrorCode } from "./errors.js";
export { TEXT_TAG } from "@svg-editor/model";
/** Pure path helpers (no document): what doc.pathEdit() / doc.pathNode() do, for previews. */
export { editPathNode, formatPath, movePathPoints, nearestOnPath, oppositeHandle, parsePath, pointOnSegment, segmentStart } from "@svg-editor/model";
export type { PathMove, PathNodeOp, PathPoint, PathSegment } from "@svg-editor/model";
/** Motion presets and their defaults. */
export { ANIMATION_TAGS, MOTION_EASINGS, MOTION_PRESETS, parseClock, PRESET_INFO } from "@svg-editor/model";
export type { AnimationInfo, MotionEasing, MotionOptions, MotionPreset, MotionTrigger, PresetInfo } from "@svg-editor/model";
export type { Mutation } from "@svg-editor/model";
export type { BBox, Command, CommandError, CommandResult, NodeData, NodeId, Query, TreeNode, Vec2 } from "@svg-editor/model";
export type { TextEdit } from "@svg-editor/parser";
export type { AbortSignalLike } from "./platform.js";
