/**
 * Tool definitions, prompt and input validation only: no SDK, no document
 * model. For code that talks to a model provider but never touches a
 * document (the desktop app's main process).
 */
export { SYSTEM_PROMPT, turnContext } from "./prompt.js";
export { TOOLS, toolsFor, VISION_TOOLS, type ToolDefinition } from "./tools.js";
export { validate, type Schema } from "./validate.js";
