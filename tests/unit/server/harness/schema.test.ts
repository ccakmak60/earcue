import { describe, expect, it } from "vitest";
import { conform, strictSchema, type JsonSchema } from "@/lib/server/harness/schema";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["idea", "draft"] },
          score: { type: "number" },
          count: { type: "integer" },
          done: { type: "boolean" },
          note: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["kind", "score"],
      },
    },
  },
  required: ["items"],
};

const good = { kind: "idea", score: 0.5 };

describe("conform", () => {
  it("keeps a conforming answer and strips properties the schema does not name", () => {
    const r = conform({ items: [{ ...good, extra: 1 }], also: true }, SCHEMA);
    expect(r).toEqual({ ok: true, value: { items: [good] }, dropped: 0 });
  });

  it("drops array items that fail, without repairing them, and counts them", () => {
    const r = conform(
      {
        items: [
          good,
          { kind: "rant", score: 0.5 }, // not in the enum
          { kind: "idea", score: "0.5" }, // a string where a number belongs
          { kind: "idea" }, // missing required
          { kind: "draft", score: 1, count: 1.5 }, // optional integer that is not one: the property goes
          "not an object",
        ],
      },
      SCHEMA
    );
    expect(r).toEqual({ ok: true, value: { items: [good, { kind: "draft", score: 1 }] }, dropped: 4 });
  });

  it("treats a null optional property as absent and drops failing nested items", () => {
    const r = conform({ items: [{ ...good, note: null, done: false, tags: ["a", 2, "b"] }] }, SCHEMA);
    expect(r).toEqual({ ok: true, value: { items: [{ ...good, done: false, tags: ["a", "b"] }] }, dropped: 1 });
  });

  it("counts a dropped item once, not once more for its own dropped children", () => {
    const r = conform({ items: [{ kind: "idea", tags: [1, 2] }] }, SCHEMA);
    expect(r).toEqual({ ok: true, value: { items: [] }, dropped: 1 });
  });

  it("fails at the top level when a required property is missing, null or the wrong type", () => {
    expect(conform({}, SCHEMA).ok).toBe(false);
    expect(conform({ items: null }, SCHEMA).ok).toBe(false);
    expect(conform({ items: "none" }, SCHEMA).ok).toBe(false);
    expect(conform([], SCHEMA).ok).toBe(false);
    expect(conform(null, SCHEMA).ok).toBe(false);
  });
});

describe("strictSchema", () => {
  it("closes every object, requires every property and makes the optional ones nullable", () => {
    const strict = strictSchema(SCHEMA) as any;
    expect(strict).toMatchObject({ type: "object", required: ["items"], additionalProperties: false });
    const item = strict.properties.items.items;
    expect(item.required).toEqual(["kind", "score", "count", "done", "note", "tags"]);
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.kind).toEqual({ type: "string", enum: ["idea", "draft"] });
    expect(item.properties.note).toEqual({ type: ["string", "null"] });
    expect(item.properties.tags).toEqual({ type: ["array", "null"], items: { type: "string" } });
  });

  it("adds null to an optional enum", () => {
    const strict = strictSchema({ type: "object", properties: { u: { type: "string", enum: ["a"] } } }) as any;
    expect(strict.properties.u).toEqual({ type: ["string", "null"], enum: ["a", null] });
  });

  it("round-trips: a strict answer with nulls for optional fields conforms to the original schema", () => {
    const answer = { items: [{ kind: "idea", score: 0.2, count: null, done: null, note: null, tags: null }] };
    expect(conform(answer, SCHEMA)).toEqual({ ok: true, value: { items: [{ kind: "idea", score: 0.2 }] }, dropped: 0 });
  });
});
