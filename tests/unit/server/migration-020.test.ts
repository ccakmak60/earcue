import { describe, expect, it } from "vitest";
import { participantsOf } from "@/lib/shared/participants";
import { applyMigrations, createUser, migratedDb } from "./_pglite";

// 020 backfills context_items.participants for rows stored before it, in SQL. It has to agree with
// participantsOf(), which fills the column for every row written after it.
describe("migration 020 participants backfill", () => {
  it("derives the same participants as participantsOf() for pre-020 rows", async () => {
    const { db, sql } = await migratedDb({ before: "020" });
    const user = await createUser(sql);
    const legacy = [
      { provider: "google", kind: "email", meta: { from: "Jane Doe <Jane@Acme.com>", threadId: "t" } },
      { provider: "google", kind: "email", meta: { from: "bob@acme.com" } },
      { provider: "google", kind: "email", meta: { from: "Mailer Daemon" } },
      { provider: "google", kind: "event", meta: { attendees: ["A@x.com", "b@y.com"], location: null } },
      { provider: "slack", kind: "message", meta: { channelId: "C1", user: "U42", threadTs: null } },
      { provider: "whatsapp", kind: "chat", meta: { chat: "Fam", participants: ["Alice", "Bob "], messageCount: 3 } },
      { provider: "browser", kind: "page", meta: { host: "x.com" } },
    ];
    for (const [i, row] of legacy.entries()) {
      await sql`
        insert into context_items (user_id, provider, external_id, ts, kind, meta)
        values (${user}, ${row.provider}, ${`e${i}`}, now(), ${row.kind}, ${JSON.stringify(row.meta)}::jsonb)
      `;
    }

    await applyMigrations(db, { from: "020" });

    const rows = await sql`select external_id, participants from context_items where user_id = ${user} order by external_id`;
    for (const [i, row] of legacy.entries()) {
      const got = [...rows[i].participants].sort();
      expect({ id: `e${i}`, got }).toEqual({ id: `e${i}`, got: participantsOf(row.provider, row.kind, row.meta).sort() });
    }
  }, 60000);
});
