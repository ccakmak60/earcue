import { describe, expect, it } from "vitest";
import { createUser, migratedDb } from "./_pglite";

// 021's constraints: the outcome set, account deletion cascading to runs, and a pruned run leaving
// its suggestions in place.
describe("migration 021 agent_runs", () => {
  it("cascades on account deletion, nulls suggestions.run_id on prune and checks the outcome", async () => {
    const { sql } = await migratedDb();
    const user = await createUser(sql);
    const run = async () =>
      (await sql`insert into agent_runs (user_id, task, prompt_version, model, outcome) values (${user}, 'briefing', '1', 'm', 'ok') returning id`)[0].id;

    const pruned = await run();
    await sql`
      insert into suggestions (user_id, client_id, local_day, kind, title, urgency, dedup_key, run_id)
      values (${user}, 'c1', current_date, 'idea', 't', 'low', 'k1', ${pruned})
    `;
    await sql`delete from agent_runs where id = ${pruned}`;
    const [s] = await sql`select run_id from suggestions where client_id = 'c1'`;
    expect(s.run_id).toBeNull();

    await expect(
      sql`insert into agent_runs (user_id, task, prompt_version, model, outcome) values (${user}, 'briefing', '1', 'm', 'maybe')`
    ).rejects.toThrow(/agent_runs_outcome_check/);

    await run();
    await sql`delete from users where id = ${user}`;
    expect(await sql`select 1 from agent_runs where user_id = ${user}`).toEqual([]);
  }, 60000);
});
