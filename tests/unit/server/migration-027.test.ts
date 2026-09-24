import { describe, expect, it } from "vitest";
import { applyMigrations, createUser, migratedDb } from "./_pglite";

// 027: open_loops and suggestions.loop_id. Nothing to backfill (loops are detected by the next
// catch-up), so this checks the shape: what the constraints refuse, the two uniqueness rules, and
// what goes when an item, a loop or an account does.
describe("migration 027 open_loops", () => {
  it("applies over 026 and holds its constraints", async () => {
    const { db, sql } = await migratedDb({ before: "027_open_loops.sql" });
    const user = await createUser(sql);
    const [item] = await sql`
      insert into context_items (user_id, provider, external_id, ts, kind, title, body) values (${user}, 'google', 'gm:1', now(), 'email', 't', 'b')
      returning id
    `;
    await applyMigrations(db, { from: "027_open_loops.sql" });

    const loop = (kind: string, itemId: unknown) => db.query("insert into open_loops (user_id, kind, context_item_id) values ($1, $2, $3) returning id", [user, kind, itemId]);
    const [{ id: loopId }] = (await loop("reply_owed", item.id)).rows as { id: number }[];

    // One loop per kind and item, whatever its status: a dismissed one blocks a new one.
    await expect(loop("reply_owed", item.id)).rejects.toThrow(/open_loops_item/);
    await sql`update open_loops set status = 'dismissed', resolved_at = now() where id = ${loopId}`;
    await expect(loop("reply_owed", item.id)).rejects.toThrow(/open_loops_item/);
    // Another kind on the same item is its own loop.
    await loop("commitment", item.id);

    await expect(loop("birthday", item.id)).rejects.toThrow(/check/);
    // An open loop has no resolved_at, and a closed one has one.
    await expect(sql`insert into open_loops (user_id, kind, context_item_id, status) values (${user}, 'waiting_on', ${item.id}, 'done')`).rejects.toThrow(/check/);
    await expect(sql`insert into open_loops (user_id, kind, context_item_id, resolved_at) values (${user}, 'waiting_on', ${item.id}, now())`).rejects.toThrow(/check/);
    // A loop rests on an item or an entity.
    await expect(sql`insert into open_loops (user_id, kind) values (${user}, 'stale_project')`).rejects.toThrow(/check/);

    // With no item, one per kind and entity.
    const [entity] = await sql`insert into entities (user_id, kind, name, name_key, status) values (${user}, 'project', 'Atlas', 'atlas', 'active') returning id`;
    await sql`insert into open_loops (user_id, kind, entity_id) values (${user}, 'stale_project', ${entity.id})`;
    await expect(sql`insert into open_loops (user_id, kind, entity_id) values (${user}, 'stale_project', ${entity.id})`).rejects.toThrow(/open_loops_entity/);

    // A suggestion points at the loop it was made from; deleting the loop keeps the suggestion.
    await sql`
      insert into suggestions (user_id, client_id, local_day, kind, title, urgency, dedup_key, loop_id)
      values (${user}, 'c1', current_date, 'draft', 'Reply', 'high', 'k1', ${loopId})
    `;
    await sql`delete from open_loops where id = ${loopId}`;
    const [s] = await sql`select loop_id from suggestions where client_id = 'c1'`;
    expect(s.loop_id).toBeNull();

    // Removing the item removes its loops; removing the entity its loops; deleting the account the rest.
    await sql`delete from context_items where id = ${item.id}`;
    expect((await sql`select kind from open_loops where user_id = ${user}`).map((r) => r.kind)).toEqual(["stale_project"]);
    await sql`delete from entities where id = ${entity.id}`;
    expect(await sql`select 1 from open_loops where user_id = ${user}`).toEqual([]);
    const [e2] = await sql`insert into entities (user_id, kind, name, name_key) values (${user}, 'person', 'Rita', 'rita') returning id`;
    await sql`insert into open_loops (user_id, kind, entity_id) values (${user}, 'reconnect', ${e2.id})`;
    await sql`delete from users where id = ${user}`;
    expect(await sql`select 1 from open_loops`).toEqual([]);

    const [fn] = await sql`select proname from pg_proc where proname = 'refresh_open_loops'`;
    expect(fn.proname).toBe("refresh_open_loops");
  }, 60000);
});
