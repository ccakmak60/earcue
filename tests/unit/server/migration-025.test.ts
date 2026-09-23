import { describe, expect, it } from "vitest";
import { applyMigrations, createUser, migratedDb } from "./_pglite";

// 025: every item the old id cursor had passed is marked distilled, so the per-item queue does not
// distill it again; items past the cursor, and every item of an account that never ran a pass,
// stay queued. The queue has its partial index.
describe("migration 025 distilled_at", () => {
  it("marks items at or below each account's distill_cursor distilled, and nothing else", async () => {
    const { db, sql } = await migratedDb({ before: "025_distilled_at.sql" });
    const cursored = await createUser(sql);
    const fresh = await createUser(sql);
    const insert = (user: string, n: number) =>
      sql`
        insert into context_items (user_id, provider, external_id, ts, kind, title, body)
        select ${user}, 'google', 'gm:' || g, now(), 'email', 't' || g, 'b' from generate_series(1, ${n}) g
        returning id
      `;
    const ids = (await insert(cursored, 5)).map((r) => Number(r.id));
    await insert(fresh, 2);
    await sql`insert into user_profile (user_id, distill_cursor) values (${cursored}, ${ids[2]})`;

    await applyMigrations(db, { from: "025_distilled_at.sql" });

    const rows = await sql`select user_id, id, distilled_at is not null as distilled from context_items order by id`;
    expect(rows.filter((r) => r.user_id === cursored).map((r) => r.distilled)).toEqual([true, true, true, false, false]);
    expect(rows.filter((r) => r.user_id === fresh).map((r) => r.distilled)).toEqual([false, false]);

    const [index] = await sql`select indexdef from pg_indexes where indexname = 'context_items_undistilled'`;
    expect(index.indexdef).toContain("WHERE (distilled_at IS NULL)");
  }, 60000);
});
