import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertMemories } from "@/lib/server/knowledge";
import type { MockSql } from "../api/_harness";
import { makeSql } from "../api/_harness";

// vi.mock factories are hoisted above these imports; state must be created through vi.hoisted so
// the factories can close over it safely.
const state = vi.hoisted(() => ({ sql: null as MockSql | null }));

vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.sql;
  },
}));
vi.mock("@/lib/server/embed", () => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [1])),
  toVectorLiteral: (values: number[]) => `[${values.join(",")}]`,
}));

const memory = {
  kind: "preference",
  subject: "Coffee",
  text: "Prefers filter coffee in the morning.",
  importance: 0.6,
  confidence: 0.8,
};

// The cut-off these exercise (MEMORY_DEDUP_SIM) is calibrated to earcue-embed, where a genuine
// duplicate of a memories.text-shaped sentence scores ~0.72-0.85 rather than the ~0.95 a
// gemini-embedding-001 pair used to. A cut-off refitted to the wrong model dedups nothing, and
// every re-distillation of the same fact inserts another row.
describe("upsertMemories dedup band", () => {
  beforeEach(() => {
    state.sql = null;
  });

  it("updates the nearest row when similarity is inside the duplicate band", async () => {
    // The second queued result only exists so a regressed cut-off fails on the assertion below
    // instead of crashing on an empty insert result.
    state.sql = makeSql([[{ id: 42, origin: "distill", sim: 0.78 }], [{ id: 99 }]]);

    const result = await upsertMemories("u1", [memory], "distill");

    expect(result).toMatchObject({ created: 0, updated: 1, idByIndex: { 0: 42 } });
    expect(state.sql.calls[1].text).toContain("update memories set");
  });

  it("inserts when similarity is below the duplicate band", async () => {
    state.sql = makeSql([[{ id: 42, origin: "distill", sim: 0.55 }], [{ id: 43 }]]);

    const result = await upsertMemories("u1", [memory], "distill");

    expect(result).toMatchObject({ created: 1, updated: 0, idByIndex: { 0: 43 } });
    expect(state.sql.calls[1].text).toContain("insert into memories");
  });
});
