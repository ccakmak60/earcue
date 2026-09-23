import { describe, expect, it } from "vitest";
import { createUser, migratedDb } from "./_pglite";

// 023: a memory points at the run that wrote it; pruning that run keeps the memory and clears the
// pointer, and deleting the account still removes both.
describe("migration 023 memories.run_id", () => {
  it("nulls run_id when the run is pruned and cascades on account deletion", async () => {
    const { db, sql } = await migratedDb();
    const user = await createUser(sql);
    const [run] = await sql`insert into agent_runs (user_id, task, prompt_version, model, outcome) values (${user}, 'chat', '1', 'm', 'ok') returning id`;
    await sql`
      insert into memories (user_id, kind, subject, subject_key, text, origin, run_id)
      values (${user}, 'preference', 'Flights', 'flights', 'Prefers aisle seats.', 'chat', ${run.id})
    `;

    await sql`delete from agent_runs where id = ${run.id}`;
    expect(await sql`select text, run_id from memories where user_id = ${user}`).toEqual([{ text: "Prefers aisle seats.", run_id: null }]);

    const { rows: index } = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'memories_run'");
    expect(index[0].indexdef).toMatch(/\(run_id\) WHERE \(run_id IS NOT NULL\)/);

    await sql`delete from users where id = ${user}`;
    expect(await sql`select 1 from memories where user_id = ${user}`).toEqual([]);
  }, 60000);
});
