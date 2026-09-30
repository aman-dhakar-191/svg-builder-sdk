/** The JSON Schema subset the tool definitions use. */
export interface Schema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: readonly (string | number)[];
  minItems?: number;
  maxItems?: number;
  /** Any of these (used for "string or number or null" attribute values). */
  anyOf?: Schema[];
  nullable?: boolean;
}

/**
 * Validates `value` against `schema`. Returns null when valid, else a precise
 * message ("elements[2].tag: expected a string") the model can correct from.
 * Model-generated tool input is untrusted: it can be truncated or malformed.
 */
export function validate(value: unknown, schema: Schema, path = "input"): string | null {
  if (value === null && schema.nullable) return null;
  if (schema.anyOf) {
    const errors = schema.anyOf.map((s) => validate(value, s, path));
    return errors.includes(null) ? null : `${path}: ${describeAny(schema.anyOf)} expected, got ${kind(value)}`;
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    return `${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}, got ${JSON.stringify(value)}`;
  }
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${path}: expected an object, got ${kind(value)}`;
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in obj) || obj[key] === undefined) return `${path}.${key}: required`;
      }
      for (const [key, v] of Object.entries(obj)) {
        const prop = schema.properties?.[key];
        if (prop) {
          const e = validate(v, prop, `${path}.${key}`);
          if (e) return e;
        } else if (schema.additionalProperties === false) {
          return `${path}.${key}: unknown property (allowed: ${Object.keys(schema.properties ?? {}).join(", ")})`;
        } else if (typeof schema.additionalProperties === "object") {
          const e = validate(v, schema.additionalProperties, `${path}.${key}`);
          if (e) return e;
        }
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path}: expected an array, got ${kind(value)}`;
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${path}: needs at least ${schema.minItems} item(s)`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path}: at most ${schema.maxItems} item(s)`;
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const e = validate(value[i], schema.items, `${path}[${i}]`);
          if (e) return e;
        }
      }
      return null;
    }
    case "string":
      return typeof value === "string" ? null : `${path}: expected a string, got ${kind(value)}`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `${path}: expected a finite number, got ${kind(value)}`;
    case "integer":
      return Number.isInteger(value) ? null : `${path}: expected an integer, got ${kind(value)}`;
    case "boolean":
      return typeof value === "boolean" ? null : `${path}: expected true or false, got ${kind(value)}`;
    default:
      return null;
  }
}

function kind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  return typeof v === "object" ? "an object" : `${typeof v} ${JSON.stringify(v)}`.slice(0, 60);
}

function describeAny(schemas: Schema[]): string {
  return schemas.map((s) => (s.nullable ? `${s.type} or null` : s.type)).join(" or ");
}
