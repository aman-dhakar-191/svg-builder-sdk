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
    name: "edit_path_nodes",
    description:
      'Changes the nodes of a <path> (a node is the end point of a segment from get_element "segments"). action "insert": adds a node on segment seg at t (0..1) without changing the outline. "delete": removes the node at the end of seg; its neighbours join. "node": type "corner" pulls its handles in (a sharp point), "smooth" lines them up (a smooth curve through it). "segment": type "line" straightens segment seg, "curve" makes it a cubic you can then bend with edit_path. Indices after the node shift; read the segments again before the next edit.',
    input_schema: {
      type: "object",
      properties: {
        id,
        action: { type: "string", enum: ["insert", "delete", "node", "segment"] },
        seg: { type: "integer" },
        t: { type: "number", description: "insert only: where on the segment, between 0 and 1; 0.5 = middle." },
        type: { type: "string", enum: ["corner", "smooth", "line", "curve"], description: 'node: "corner" or "smooth"; segment: "line" or "curve".' },
      },
      required: ["id", "action", "seg"],
      additionalProperties: false,
    },
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
    name: "combine_shapes",
    description:
      'Combines two or more sibling shapes (paths or basic shapes) into one <path>, like a vector editor\'s Pathfinder: "union" merges them, "subtract" cuts all the others out of the bottom-most one (e.g. a crescent: a circle minus an offset circle drawn on top), "intersect" keeps only the shared area, "exclude" keeps everything except the overlaps. The result gets the bottom shape\'s style and place; the operands are removed. Returns the new ID.',
    input_schema: {
      type: "object",
      properties: { operation: { type: "string", enum: ["union", "subtract", "intersect", "exclude"] }, ids: ids(2) },
      required: ["operation", "ids"],
      additionalProperties: false,
    },
  },
  {
    name: "simplify_path",
    description: "Refits a <path> with fewer points while keeping its look. tolerance: largest allowed deviation in the path's units (default 1; larger = smoother, fewer points).",
    input_schema: { type: "object", properties: { id, tolerance: { type: "number" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "animate_elements",
    description:
      'Animates elements with a motion preset (stored as SMIL in the SVG, so it plays in browsers and in the editor\'s preview). Entrances play once and stay: "fadeIn", "slideIn" (from: left/right/top/bottom, distance), "popIn" (scales up from nothing), "drawOn" (draws the stroke; needs a stroke, fades a fill in at the end). Loops repeat forever unless repeat says otherwise: "spin" (clockwise), "pulse", "float" (bobs up, distance), "wiggle". Applying a preset again to the same element replaces it; different presets combine (e.g. fadeIn + slideIn). Times are in seconds. stagger delays each next element by that much, for sequences. trigger: "load" (default, when the drawing opens), "click" or "hover".',
    input_schema: {
      type: "object",
      properties: {
        ids: ids(),
        preset: { type: "string", enum: ["fadeIn", "slideIn", "popIn", "drawOn", "spin", "pulse", "float", "wiggle"] },
        duration: { type: "number", description: "Seconds for one run. Defaults: fadeIn/slideIn 0.6, popIn 0.5, drawOn 1.5, spin 2, pulse 1, float 2, wiggle 0.8." },
        delay: { type: "number", description: "Seconds before it starts. Default 0." },
        stagger: { type: "number", description: "Extra delay per element, in the order of ids. Default 0." },
        repeat: { anyOf: [{ type: "number" }, { type: "string", enum: ["indefinite"] }], description: 'Number of runs, or "indefinite".' },
        trigger: { type: "string", enum: ["load", "click", "hover"] },
        easing: { type: "string", enum: ["linear", "ease", "easeIn", "easeOut", "easeInOut"] },
        from: { type: "string", enum: ["left", "right", "top", "bottom"], description: "slideIn only. Default bottom." },
        distance: { type: "number", description: "slideIn/float: how far, in drawing units. Default: from the element's size." },
        clockwise: { type: "boolean", description: "spin only. Default true." },
      },
      required: ["ids", "preset"],
      additionalProperties: false,
    },
  },
  {
    name: "set_keyframes",
    description:
      'Keyframe animation, for motion the presets cannot do: sets one property of an element at points in time (seconds from the start); in between it is interpolated with the easing. Properties and values: "translate" [dx, dy] offset in the element\'s own units, "rotate" degrees and "scale" a number or [sx, sy] (both about the element\'s centre), "opacity" 0..1, "fill" / "stroke" colours (they change at each key). Replaces that property\'s keys on the element; keys: [] removes them. Before the first key the first value holds. Combine several properties for one movement (e.g. translate and opacity with the same times).',
    input_schema: {
      type: "object",
      properties: {
        id,
        property: { type: "string", enum: ["translate", "rotate", "scale", "opacity", "fill", "stroke"] },
        keys: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: { time: { type: "number", description: "Seconds from the start." }, value: { anyOf: [{ type: "number" }, { type: "string" }, vec2] } },
            required: ["time", "value"],
            additionalProperties: false,
          },
        },
        easing: { type: "string", enum: ["linear", "ease", "easeIn", "easeOut", "easeInOut"], description: "Default easeInOut." },
      },
      required: ["id", "property", "keys"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_animations",
    description: "Removes animations from elements: only those of one preset, or (without preset) all of them, hand-written ones included.",
    input_schema: {
      type: "object",
      properties: { ids: ids(), preset: { type: "string", enum: ["fadeIn", "slideIn", "popIn", "drawOn", "spin", "pulse", "float", "wiggle", "keys"], description: '"keys" removes keyframes.' } },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "set_background",
    description:
      'Sets the colour behind the whole page (a full-page rect behind everything, kept in the saved SVG; the user can leave it out when exporting), or removes it with null. Use it instead of drawing your own page-sized rectangle, e.g. to show a logo on black.',
    input_schema: { type: "object", properties: { color: { type: "string", nullable: true, description: 'A CSS colour such as "#0b1020", or null for none (transparent).' } }, required: ["color"], additionalProperties: false },
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
      "Returns a PNG picture of the drawing (white background) so you can check your work visually. Animations are not played: it shows the drawing at rest. By default the whole page; pass ids to zoom in on elements (with padding), or region for any rectangle in drawing units. Use it after a change whose look matters, not after every call; snapshots per turn are limited.",
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
