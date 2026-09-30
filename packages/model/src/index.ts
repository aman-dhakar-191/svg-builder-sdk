export { createDocument, SvgDocument } from "./document.js";
export type { CreateDocumentOptions, HistoryEvent, MutationListener, Transaction } from "./document.js";
export type { Mutation } from "./mutations.js";
export { escapeAttr, escapeText, serialize, TEXT_CONTAINERS, type SerializeOptions } from "./serialize.js";
export { TEXT_TAG } from "./types.js";
export { CommandFailure } from "./errors.js";
export { formatPath, movePathPoints, parsePath, type PathMove, type PathPoint, type PathSegment } from "./path.js";
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
  multiply,
  parseTransform,
  transformBBox,
  unionBBox,
  type Matrix,
} from "./geometry.js";
