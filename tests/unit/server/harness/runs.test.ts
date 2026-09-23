import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createUser, migratedDb, type TestDb } from "../_pglite";

// The run log writer against the migrated schema: one agent_runs row per run, whatever the outcome.
const state = vi.hoisted(() => ({ t: null as unknown as TestDb }));
vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.t.sql;
  },
}));

import { SpendCeilingReached } from "@/lib/server/errors";
import { errorCode, pruneRuns, Run } from "@/lib/server/harness/runs";
import { InvalidOutput } from "@/lib/server/llm";

const PROMPT = { version: "7", text: "do the thing" };

const rowsOf = (user: string) => state.t.sql`select * from agent_runs where user_id = ${user} order by started_at, id`;

beforeAll(async () => {
  state.t = await migratedDb();
}, 60000);

describe("Run.track", () => {
  it("writes the row before the model call and completes it after", async () => {
    const user = await createUser(state.t.sql);
    const run = new Run(user, "briefing", PROMPT, "earcue-reason");
    run.refs.item(11);
    run.refs.memory(22);

    const result = await run.track(async () => {
      const [during] = await rowsOf(user);
      expect(during).toMatchObject({ outcome: "error", error: "unfinished", ms: null });
      run.meter.steps = 2;
      run.meter.promptTokens = 100;
      run.meter.completionTokens = 20;
      run.output = { suggestions: [5] };
      run.settle(1);
      return "done";
    });

    expect(result).toBe("done");
    const [row] = await rowsOf(user);
    expect(row).toMatchObject({
      id: run.id,
      task: "briefing",
      prompt_version: "7",
      model: "earcue-reason",
      outcome: "ok",
      error: null,
      steps: 2,
      prompt_tokens: 100,
      completion_tokens: 20,
      tool_calls: [],
      input_refs: { items: [11], memories: [22] },
      output: { suggestions: [5], schema_dropped: 0 },
    });
    expect(row.ms).toBeGreaterThanOrEqual(0);
  });

  it("records error, ceiling and invalid outcomes with a code, never the message, and rethrows", async () => {
    const user = await createUser(state.t.sql);
    const cases: [Error, string, string][] = [
      [new Error("llm 400: the prompt said something private"), "error", "llm_400"],
      [new SpendCeilingReached("llm: daily token ceiling reached"), "ceiling", "ceiling"],
      [new InvalidOutput("parseJsonText failed; first 500 chars: private answer"), "invalid", "invalid_output"],
    ];
    for (const [err] of cases) {
      const run = new Run(user, "distill", PROMPT, "m");
      await expect(run.track(async () => Promise.reject(err))).rejects.toBe(err);
    }
    const rows = await rowsOf(user);
    expect(rows.map((r) => [r.outcome, r.error])).toEqual(cases.map(([, outcome, code]) => [outcome, code]));
    expect(JSON.stringify(rows)).not.toContain("private");
  });

  it("settles empty when nothing was produced and invalid when the checks removed everything", async () => {
    const user = await createUser(state.t.sql);
    const empty = new Run(user, "consolidate", PROMPT, "m");
    await empty.track(async () => empty.settle(0));
    const invalid = new Run(user, "consolidate", PROMPT, "m");
    await invalid.track(async () => invalid.settle(0, 3));
    const schemaDropped = new Run(user, "consolidate", PROMPT, "m");
    await schemaDropped.track(async () => {
      schemaDropped.meter.dropped = 1;
      schemaDropped.settle(0);
    });
    expect((await rowsOf(user)).map((r) => r.outcome)).toEqual(["empty", "invalid", "invalid"]);
  });

  it("never fails the task when the row cannot be written", async () => {
    const run = new Run(randomUUID(), "profile", PROMPT, "m"); // no such user: the insert breaks the FK
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run.track(async () => 42)).resolves.toBe(42);
    expect(run.id).toBeNull();
    expect(spy.mock.calls.some(([line]) => String(line).includes("agent_run_record_failed"))).toBe(true);
    spy.mockRestore();
  });
});

describe("errorCode", () => {
  it("maps known failures to coarse codes", () => {
    expect(errorCode(new Error("llm 503: busy"))).toBe("llm_503");
    expect(errorCode(new Error("llm: deadline exceeded"))).toBe("deadline");
    expect(errorCode(new TypeError("x of undefined"))).toBe("TypeError");
  });
});

describe("pruneRuns", () => {
  it("deletes every account's runs older than 30 days and keeps the rest", async () => {
    const a = await createUser(state.t.sql);
    const b = await createUser(state.t.sql);
    for (const [user, age] of [[a, 31], [b, 45], [a, 29], [b, 0]] as const) {
      await state.t.sql`
        insert into agent_runs (user_id, task, prompt_version, model, outcome, started_at)
        values (${user}, 'distill', '1', 'm', 'ok', now() - (${age} || ' days')::interval)
      `;
    }
    expect(await pruneRuns()).toBeGreaterThanOrEqual(2);
    const left = await state.t.sql`
      select user_id, extract(day from now() - started_at)::int as age from agent_runs where user_id in (${a}, ${b}) order by age
    `;
    expect(left.map((r) => [r.user_id, r.age])).toEqual([
      [b, 0],
      [a, 29],
    ]);
  });
});
