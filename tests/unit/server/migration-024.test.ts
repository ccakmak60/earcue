import { describe, expect, it } from "vitest";
import { applyMigrations, createUser, migratedDb } from "./_pglite";
import { ANNOTATE_KINDS } from "@/lib/server/annotate";
import { threadKeyOf } from "@/lib/server/knowledge";

// 024: rows stored before it get the thread_key threadKeyOf() gives new rows, the annotate queue
// index covers ANNOTATE_KINDS, triage takes only its three values, and usage_daily gains the
// annotations counter.
describe("migration 024 item signals", () => {
  const OLD_ROWS = [
    { provider: "google", external_id: "gm:a", kind: "email", meta: { threadId: "18c2f", from: "x@y.example" } },
    { provider: "google", external_id: "gm:b", kind: "email", meta: { threadId: null } },
    { provider: "google", external_id: "gcal:1", kind: "event", meta: { attendees: [] } },
    { provider: "whatsapp", external_id: "wa:1", kind: "chat", meta: { chat: "Inês Moreno", participants: ["Inês Moreno"] } },
    { provider: "slack", external_id: "C1:1700.1", kind: "message", meta: { channelId: "C1", threadTs: null } },
    { provider: "slack", external_id: "C1:1700.2", kind: "message", meta: { channelId: "C1", threadTs: "1700.1" } },
    { provider: "upload", external_id: "doc:notes:10:0", kind: "doc", meta: { part: 1 } },
    { provider: "browser", external_id: "bh:1", kind: "page", meta: { host: "example.com" } },
  ];

  it("backfills thread_key exactly as threadKeyOf() sets it", async () => {
    const { db, sql } = await migratedDb({ before: "024_item_signals.sql" });
    const user = await createUser(sql);
    for (const r of OLD_ROWS) {
      await sql`
        insert into context_items (user_id, provider, external_id, ts, kind, title, body, meta)
        values (${user}, ${r.provider}, ${r.external_id}, now(), ${r.kind}, 't', 'b', ${JSON.stringify(r.meta)}::jsonb)
      `;
    }

    await applyMigrations(db, { from: "024_item_signals.sql" });

    const rows = await sql`select external_id, thread_key, signals_at, triage from context_items where user_id = ${user} order by id`;
    expect(rows.map((r) => r.thread_key)).toEqual(OLD_ROWS.map((r) => threadKeyOf(r.provider, r.external_id, r.meta)));
    expect(rows.map((r) => r.thread_key)).toEqual([
      "gm:18c2f",
      null,
      null,
      threadKeyOf("whatsapp", "", { chat: "Inês Moreno" }),
      "slack:C1:1700.1",
      "slack:C1:1700.1",
      null,
      null,
    ]);
    // Every row starts pending.
    expect(rows.every((r) => r.signals_at === null && r.triage === null)).toBe(true);
  }, 60000);

  it("indexes the annotate queue over ANNOTATE_KINDS, checks triage and adds the quota counter", async () => {
    const { db, sql } = await migratedDb();
    const { rows: index } = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'context_items_unannotated'");
    const kinds = /kind = ANY \(ARRAY\[(.*)\]\)/.exec(index[0].indexdef)?.[1].match(/'([a-z_]+)'/g)?.map((k) => k.slice(1, -1));
    expect(index[0].indexdef).toContain("(user_id, id) WHERE ((signals_at IS NULL)");
    expect(kinds).toEqual(ANNOTATE_KINDS);
    const { rows: thread } = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'context_items_thread'");
    expect(thread[0].indexdef).toContain("(user_id, thread_key, ts) WHERE (thread_key IS NOT NULL)");

    const user = await createUser(sql);
    await expect(
      sql`insert into context_items (user_id, provider, external_id, ts, kind, title, body, triage) values (${user}, 'google', 'gm:x', now(), 'email', 't', 'b', 'maybe')`
    ).rejects.toThrow(/check/);

    await sql`insert into usage_daily (user_id, day) values (${user}, current_date)`;
    expect(await sql`select annotations from usage_daily where user_id = ${user}`).toEqual([{ annotations: 0 }]);

    await sql`delete from users where id = ${user}`;
  }, 60000);
});
