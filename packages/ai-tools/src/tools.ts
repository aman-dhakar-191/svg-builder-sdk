import type { Schema } from "./validate.js";

/** A tool definition in provider-neutral form (JSON Schema input). */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Schema & { type: "object" };
}

const id: Schema = { type: "string", description: 'Element ID, e.g. "n_12" (from get_document, query_elements or an earlier result).' };
const ids = (min = 1): Schema => ({ type: "array", items: id, minItems: min, maxItems: 500 });
const attrValue: Schema = { anyOf: [{ type: "string" }, { type: "number" }] };
const vec2: Schema = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 };

/**
 * The tools the AI can use. Deliberately high-level and few: each maps to one
 * SDK call (add_elements batches several), and every failure comes back as
 * { code, message, hint } so the model can correct itself.
 */
export const TOOLS: ToolDefinition[] = [
  {
    name: "get_document",
    description:
      "Returns the drawing's coordinate system (viewBox, width, height), the user's current selection, and an outline of all elements (id, tag, attributes, text). Call this first when you need to know what is already in the drawing.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "query_elements",
    description: 'Finds elements by tag and/or attribute values. attributes: { "fill": "red" } matches exact values; { "stroke": true } matches elements that have the attribute.',
    input_schema: {
      type: "object",
      properties: {
        tag: { type: "string", description: 'Element name, e.g. "rect".' },
        attributes: { type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "boolean" }] } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_element",
    description: "Returns one element: tag, attributes, text content, parent, children IDs and bounding box in drawing coordinates (when measurable).",
    input_schema: { type: "object", properties: { id }, required: ["id"], additionalProperties: false },
  },
  {
    name: "add_elements",
    description:
      'Adds one or more SVG elements in order and returns their IDs. Coordinates are in the drawing\'s viewBox units. Use "text" for the content of <text>. "parent" is an existing ID, or "$N" for the N-th element created earlier in the same call (e.g. create a <g> first, then its children with parent "$0"). All-or-nothing: if one element fails, none are added.',
    input_schema: {
      type: "object",
      properties: {
        elements: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            properties: {
              tag: { type: "string", description: 'SVG element name: "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "g", ...' },
              attributes: { type: "object", additionalProperties: attrValue, description: 'e.g. { "x": 10, "y": 10, "width": 80, "height": 40, "fill": "#dc2626" }' },
              text: { type: "string", description: "Text content (for <text>, <tspan>, <title>)." },
              parent: { type: "string", description: 'Parent element ID or "$N". Default: the root <svg>.' },
              index: { type: "integer", description: "Position among the parent's children. Default: last (drawn on top)." },
            },
            required: ["tag"],
            additionalProperties: false,
          },
        },
      },
      required: ["elements"],
      additionalProperties: false,
    },
  },
  {
    name: "set_attributes",
    description: "Sets attributes on one element. A null value removes the attribute.",
    input_schema: {
      type: "object",
      properties: { id, attributes: { type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }], nullable: true } } },
      required: ["id", "attributes"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_elements",
    description: "Deletes elements (and everything inside them).",
    input_schema: { type: "object", properties: { ids: ids() }, required: ["ids"], additionalProperties: false },
  },
  {
    name: "move_element",
    description: "Moves an element to another parent and/or position in the stacking order (index = final position among the parent's children; later children draw on top).",
    input_schema: { type: "object", properties: { id, parent: id, index: { type: "integer" } }, required: ["id", "parent", "index"], additionalProperties: false },
  },
  {
    name: "group_elements",
    description: "Wraps sibling elements in a new <g>; returns its ID.",
    input_schema: { type: "object", properties: { ids: ids() }, required: ["ids"], additionalProperties: false },
  },
  {
    name: "ungroup_element",
    description: "Removes a <g>, keeping its children where they are.",
    input_schema: { type: "object", properties: { id }, required: ["id"], additionalProperties: false },
  },
  {
    name: "transform_element",
    description:
      'Translates, scales and/or rotates an element (adds to its transform attribute). rotate is in degrees, clockwise. origin: "center" (the element\'s center) or [x, y]; default [0, 0].',
    input_schema: {
      type: "object",
      properties: {
        id,
        translate: vec2,
        scale: { anyOf: [{ type: "number" }, vec2] },
        rotate: { type: "number" },
        origin: { anyOf: [{ type: "string", enum: ["center"] }, vec2] },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "convert_to_path",
    description: "Replaces basic shapes (rect, circle, ellipse, line, polyline, polygon) by equivalent <path> elements, so their outline can be edited point by point. Returns the new IDs (the old IDs are gone).",
    input_schema: { type: "object", properties: { ids: ids() }, required: ["ids"], additionalProperties: false },
  },
  {
    name: "edit_path",
    description:
      'Moves points of a <path>. Get its segments with get_element (field "segments": absolute M, L, C, Q, A, Z, indexed from 0). point: "p" = the segment\'s end point, "c1"/"c2" = control points of a C, "c" = control point of a Q. Coordinates are in the path\'s own units. Moving an end point also moves its handles unless keep_handles is false. To reshape a path completely, set its "d" with set_attributes instead.',
    input_schema: {
      type: "object",
      properties: {
        id,
        moves: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: {
            type: "object",
            properties: { seg: { type: "integer" }, point: { type: "string", enum: ["p", "c1", "c2", "c"] }, to: vec2 },
            required: ["seg", "point", "to"],
            additionalProperties: false,
          },
        },
        keep_handles: { type: "boolean", description: "Default true: handles move with their end point." },
      },
      required: ["id", "moves"],
      additionalProperties: false,
    },
  },
  {
    name: "set_text",
    description: "Replaces the text content of an element such as <text>.",
    input_schema: { type: "object", properties: { id, text: { type: "string" } }, required: ["id", "text"], additionalProperties: false },
  },
  {
    name: "align_elements",
    description: 'Aligns elements to the edge or center of their combined bounding box: "left", "right", "top", "bottom", "center" (horizontal centers) or "middle" (vertical centers).',
    input_schema: {
      type: "object",
      properties: { ids: ids(2), edge: { type: "string", enum: ["left", "right", "top", "bottom", "center", "middle"] } },
      required: ["ids", "edge"],
      additionalProperties: false,
    },
  },
  {
    name: "distribute_elements",
    description: "Spaces elements evenly between the first and last (by center), horizontally or vertically.",
    input_schema: {
      type: "object",
      properties: { ids: ids(3), axis: { type: "string", enum: ["horizontal", "vertical"] } },
      required: ["ids", "axis"],
      additionalProperties: false,
    },
  },
  {
    name: "render_snapshot",
    description:
      "Returns a PNG picture of the drawing (white background) so you can check your work visually. By default the whole page; pass ids to zoom in on elements (with padding), or region for any rectangle in drawing units. Use it after a change whose look matters, not after every call; snapshots per turn are limited.",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: id, minItems: 1, maxItems: 500, description: "Frame these elements." },
        padding: { type: "number", description: "Space around ids, in drawing units. Default: 10% of their size." },
        region: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
          required: ["x", "y", "width", "height"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "select_elements",
    description: "Selects elements in the editor so the user sees them highlighted (e.g. what you just changed). Empty list clears the selection.",
    input_schema: { type: "object", properties: { ids: { type: "array", items: id } }, required: ["ids"], additionalProperties: false },
  },
];

/** Tools that return images; left out for models without image input. */
export const VISION_TOOLS: ReadonlySet<string> = new Set(["render_snapshot"]);

/** The tool list for a model, with or without image input. */
export function toolsFor(options: { vision: boolean }): ToolDefinition[] {
  return options.vision ? TOOLS : TOOLS.filter((t) => !VISION_TOOLS.has(t.name));
}
