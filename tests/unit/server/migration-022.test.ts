import { describe, expect, it } from "vitest";
import { applyMigrations, createUser, migratedDb } from "./_pglite";

// 022 backfills forgotten_reason = 'decay' for every memory forgetStaleMemories() had already
// forgotten, leaves live ones alone, and from then on keeps forgotten_at and forgotten_reason paired.
describe("migration 022 memory tombstones", () => {
  it("backfills decay for already-forgotten memories and enforces the reason", async () => {
    const { db, sql } = await migratedDb({ before: "022" });
    const user = await createUser(sql);
    await sql`
      insert into memories (user_id, kind, subject, subject_key, text, origin, forgotten_at)
      values (${user}, 'episode', 'Trip', 'trip', 'Faded.', 'import', now() - interval '3 days'),
             (${user}, 'fact', 'Desk', 'desk', 'Live.', 'import', null)
    `;

    await applyMigrations(db, { from: "022" });

    const rows = await sql`select text, forgotten_reason from memories where user_id = ${user} order by text`;
    expect(rows).toEqual([
      { text: "Faded.", forgotten_reason: "decay" },
      { text: "Live.", forgotten_reason: null },
    ]);

    await expect(sql`update memories set forgotten_at = now(), forgotten_reason = 'bored' where text = 'Live.'`).rejects.toThrow(
      /memories_forgotten_reason_check/
    );
    await expect(sql`update memories set forgotten_at = now() where text = 'Live.'`).rejects.toThrow(/memories_forgotten_pair/);
    await expect(sql`update memories set forgotten_reason = 'user' where text = 'Live.'`).rejects.toThrow(/memories_forgotten_pair/);

    const { rows: index } = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'memories_tombstones'");
    expect(index[0].indexdef).toMatch(/\(user_id, subject_key\) WHERE \(forgotten_reason = 'user'::text\)/);
  }, 60000);
});
