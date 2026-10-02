export { createDocument, SvgDocument } from "./document.js";
export type { CreateDocumentOptions, HistoryEvent, MutationListener, Transaction } from "./document.js";
export type { Mutation } from "./mutations.js";
export { escapeAttr, escapeText, serialize, TEXT_CONTAINERS, type SerializeOptions } from "./serialize.js";
export { TEXT_TAG } from "./types.js";
export {
  ANIMATION_TAGS,
  buildMotion,
  DRAWABLE_TAGS,
  MOTION_EASINGS,
  MOTION_PRESETS,
  parseClock,
  PRESET_INFO,
  readAnimation,
  timelineEnd,
  type AnimationInfo,
  type MotionEasing,
  type MotionOptions,
  type MotionPreset,
  type MotionTrigger,
  type PresetInfo,
} from "./animation.js";
export { CommandFailure } from "./errors.js";
export { pathBBox } from "./path.js";
export { KEY_PROPERTIES, readTracks, valueAt, type Keyframe, type KeyProperty, type KeyTrack, type KeyValue } from "./keyframes.js";
export { editPathNode, formatPath, movePathPoints, nearestOnPath, oppositeHandle, parsePath, pointOnSegment, segmentStart, type PathMove, type PathNodeOp, type PathPoint, type PathSegment } from "./path.js";
export type {
  BBox,
  Command,
  CommandError,
  CommandOp,
  CommandResult,
  CommandResultMap,
  DocumentState,
  ErrorCode,
  NodeData,
  NodeId,
  Query,
  InputTree,
  SvgNode,
  TreeNode,
  Vec2,
} from "./types.js";
export {
  applyToPoint,
  formatNumber,
  IDENTITY,
  invert,
  multiply,
  parseTransform,
  transformBBox,
  unionBBox,
  type Matrix,
} from "./geometry.js";
