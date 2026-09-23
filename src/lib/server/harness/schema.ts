import "server-only";

// The subset of JSON Schema every chatJson schema uses: type, properties, required, enum, items.
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: readonly string[];
  required?: readonly string[];
}

export type Conformed = { ok: true; value: unknown; dropped: number } | { ok: false; dropped: number };

// Checks a parsed model answer against `schema` and keeps what conforms. Nothing is repaired: a
// "0.8" where a number belongs is wrong, not coerced. An array item that fails is dropped and
// counted; an optional property that fails (or is null) is removed, as if the model had left it
// out; a missing or failing required property fails the object that holds it. Properties the
// schema does not name are removed. A top-level failure is `ok: false`.
export function conform(value: unknown, schema: JsonSchema): Conformed {
  let dropped = 0;

  const walk = (v: unknown, s: JsonSchema): { ok: true; value: unknown } | { ok: false } => {
    switch (s.type) {
      case "object": {
        if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false };
        const input = v as Record<string, unknown>;
        const required = new Set(s.required ?? []);
        const out: Record<string, unknown> = {};
        for (const [key, sub] of Object.entries(s.properties ?? {})) {
          const present = input[key] !== undefined && input[key] !== null;
          const r = present ? walk(input[key], sub) : ({ ok: false } as const);
          if (r.ok) out[key] = r.value;
          else if (required.has(key)) return { ok: false };
        }
        return { ok: true, value: out };
      }
      case "array": {
        if (!Array.isArray(v)) return { ok: false };
        const out: unknown[] = [];
        for (const item of v) {
          // A dropped item counts once, not once more for each of its own dropped children.
          const before = dropped;
          const r = s.items ? walk(item, s.items) : { ok: true as const, value: item };
          if (r.ok) out.push(r.value);
          else dropped = before + 1;
        }
        return { ok: true, value: out };
      }
      case "string":
        if (typeof v !== "string") return { ok: false };
        return s.enum && !s.enum.includes(v) ? { ok: false } : { ok: true, value: v };
      case "number":
        return typeof v === "number" && Number.isFinite(v) ? { ok: true, value: v } : { ok: false };
      case "integer":
        return Number.isInteger(v) ? { ok: true, value: v } : { ok: false };
      case "boolean":
        return typeof v === "boolean" ? { ok: true, value: v } : { ok: false };
      default:
        return { ok: true, value: v };
    }
  };

  const r = walk(value, schema);
  return r.ok ? { ok: true, value: r.value, dropped } : { ok: false, dropped };
}

// The same schema in the form Azure OpenAI's `response_format: json_schema` with `strict: true`
// accepts: every object closed (`additionalProperties: false`) and every property required, with
// the optional ones made nullable instead. conform() reads a null optional property as absent.
export function strictSchema(schema: JsonSchema, nullable = false): Record<string, unknown> {
  const out: Record<string, unknown> = { type: nullable && schema.type ? [schema.type, "null"] : schema.type };
  if (schema.enum) out.enum = nullable ? [...schema.enum, null] : [...schema.enum];
  if (schema.type === "object") {
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    out.properties = Object.fromEntries(Object.entries(props).map(([k, sub]) => [k, strictSchema(sub, !required.has(k))]));
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  if (schema.type === "array") out.items = strictSchema(schema.items ?? { type: "string" });
  return out;
}
