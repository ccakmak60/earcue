import { describe, expect, it, vi } from "vitest";
import { applyMigrations, createUser, migratedDb, type TestDb } from "./_pglite";

// 028: aliases merge on an exact address only. The name merges 026 made are split into a person of
// their own with their items, `name` is no longer an alias source, and from here the insert path
// gives the same people as the migrated data.
const state = vi.hoisted(() => ({ t: null as unknown as TestDb }));
vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.t.sql;
  },
}));

import { insertContextItems } from "@/lib/server/knowledge";
import { participantsOf } from "@/lib/shared/participants";

const MIGRATION = "028_exact_alias_merge.sql";

const ITEMS: [string, string, string, Record<string, unknown>][] = [
  ["gm:1", "google", "email", { from: "Inês Moreno <ines@mail.example>", to: "Alex <alex@example.com>" }],
  ["wa:1", "whatsapp", "chat", { chat: "Inês Moreno", participants: ["Inês Moreno", "Alex"] }],
  // The other order: a contact first, then an address whose display name is that contact's name.
  ["wa:2", "whatsapp", "chat", { chat: "Marco", participants: ["Marco Tavares", "Alex"] }],
  ["gm:2", "google", "email", { from: "Marco Tavares <marco@x.example>", to: "Alex <alex@example.com>" }],
];

// Stored through 026's link_participants, one item at a time as the insert path called it.
async function seedMerged(sql: TestDb["sql"], user: string) {
  for (const [externalId, provider, kind, meta] of ITEMS) {
    const participants = participantsOf(provider, kind, meta);
    const [{ id }] = await sql`
      insert into context_items (user_id, provider, external_id, ts, kind, title, body, meta, participants)
      values (${user}, ${provider}, ${externalId}, now() - interval '1 day', ${kind}, 't', 'b', ${JSON.stringify(meta)}::jsonb, ${participants}::text[])
      returning id
    `;
    const names = participants.map((key) =>
      key.startsWith("whatsapp:")
        ? ((meta.participants as string[]).find((n) => `whatsapp:${n.toLowerCase()}` === key) ?? "")
        : (/^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(String(meta.from).toLowerCase().includes(key) ? String(meta.from) : String(meta.to))?.[1] ?? "")
    );
    const roles = participants.map((key) => (String(meta.from ?? "").toLowerCase().includes(key) || kind === "chat" ? "from" : "to"));
    await sql`select link_participants(${user}::uuid, ${participants.map(() => id)}::bigint[], ${participants}::text[], ${names}::text[], ${roles}::text[])`;
  }
  await sql`
    insert into memories (user_id, kind, subject, subject_key, text, origin, entity_id)
    select ${user}, 'person', 'Inês Moreno', 'ines moreno', 'Inês Moreno is Alex''s sister.', 'import', entity_id
    from entity_aliases where user_id = ${user} and alias = 'ines@mail.example'
  `;
}

const people = async (sql: TestDb["sql"], user: string) =>
  (
    await sql`
      select e.name, array_agg(a.alias || ' ' || a.source order by a.alias) as aliases,
             (select array_agg(ci.external_id || ' ' || ie.role order by ci.external_id, ie.role) from item_entities ie join context_items ci on ci.id = ie.context_item_id where ie.entity_id = e.id) as items
      from entities e join entity_aliases a on a.entity_id = e.id
      where e.user_id = ${user} and e.kind = 'person' and not e.is_self
      group by e.id
    `
  )
    .map((r) => JSON.stringify(r))
    .sort();

describe("migration 028 exact alias merge", () => {
  it("splits 026's name merges into a person each, with their items, and drops the `name` source", async () => {
    const { db, sql } = await migratedDb({ before: MIGRATION });
    const user = await createUser(sql);
    await seedMerged(sql, user);
    const merged = await sql`select alias, source from entity_aliases where user_id = ${user} and source = 'name' order by alias`;
    // 026 merged all three by name, the person's own WhatsApp name with their mail name among them.
    expect(merged.map((r) => r.alias)).toEqual(["marco@x.example", "whatsapp:alex", "whatsapp:inês moreno"]);

    await applyMigrations(db, { from: MIGRATION });

    expect(await people(sql, user)).toEqual(
      [
        { name: "Alex", aliases: ["alex@example.com participant"], items: ["gm:1 to", "gm:2 to"] },
        { name: "Alex", aliases: ["whatsapp:alex participant"], items: ["wa:1 from", "wa:2 from"] },
        { name: "Inês Moreno", aliases: ["ines@mail.example participant"], items: ["gm:1 from"] },
        { name: "Inês Moreno", aliases: ["whatsapp:inês moreno participant"], items: ["wa:1 from"] },
        { name: "Marco Tavares", aliases: ["marco@x.example participant"], items: ["gm:2 from"] },
        { name: "Marco Tavares", aliases: ["whatsapp:marco tavares participant"], items: ["wa:2 from"] },
      ]
        .map((r) => JSON.stringify(r))
        .sort()
    );
    // The memory stays with the entity it was linked to: the mail one.
    const [memory] = await sql`
      select a.alias from memories m join entity_aliases a on a.entity_id = m.entity_id where m.user_id = ${user} order by a.alias limit 1
    `;
    expect(memory.alias).toBe("ines@mail.example");
    await expect(sql`update entity_aliases set source = 'name' where user_id = ${user}`).rejects.toThrow(/entity_aliases_source_check/);
  }, 60000);

  it("the insert path merges on an exact address only, and gives the same people as the migrated data", async () => {
    const { db, sql } = await migratedDb({ before: MIGRATION });
    const old = await createUser(sql);
    await seedMerged(sql, old);
    await applyMigrations(db, { from: MIGRATION });

    state.t = { db, sql };
    const fresh = await createUser(sql);
    for (const [externalId, provider, kind, meta] of ITEMS) {
      await insertContextItems(fresh, provider, null, [{ externalId, ts: new Date().toISOString(), kind, title: "t", body: "b", url: null, meta }]);
    }
    await insertContextItems(fresh, "google", null, [
      // The same address again, under another display name: still the same person.
      { externalId: "gm:3", ts: new Date().toISOString(), kind: "email", title: "t", body: "b", url: null, meta: { from: "Inês M. <INES@mail.example>", to: "Alex <alex@example.com>" } },
    ]);
    const freshPeople = (await people(sql, fresh)).map((p) => p.replace(/,"gm:3 (from|to)"/g, ""));
    expect(freshPeople).toEqual(await people(sql, old));
  }, 60000);
});
