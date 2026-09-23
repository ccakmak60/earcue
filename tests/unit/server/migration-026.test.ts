import { describe, expect, it, vi } from "vitest";
import { applyMigrations, createUser, migratedDb, type TestDb } from "./_pglite";

// 026: rows stored before entities existed get them. Items' participants become people with the
// link_participants the insert path called then (D6's name merge included, which migration 028
// removed: migration-028.test.ts), person and project memories are linked by subject_key, and the
// work queues take notes. Each test applies 026 alone.
const state = vi.hoisted(() => ({ t: null as unknown as TestDb }));
vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.t.sql;
  },
}));

import { insertContextItems, subjectKeyOf } from "@/lib/server/knowledge";
import { participantsOf } from "@/lib/shared/participants";

const MIGRATION = "026_entities.sql";
const NEXT = "027_open_loops.sql";

async function seedOldShape(sql: TestDb["sql"], user: string) {
  const item = (externalId: string, provider: string, kind: string, meta: Record<string, unknown>) =>
    sql`
      insert into context_items (user_id, provider, external_id, ts, kind, title, body, meta, participants)
      values (${user}, ${provider}, ${externalId}, now() - interval '1 day', ${kind}, 't', 'b', ${JSON.stringify(meta)}::jsonb,
              ${participantsOf(provider, kind, meta)}::text[])
    `;
  await item("gm:1", "google", "email", { from: "Inês Moreno <ines@mail.example>", to: "Alex <alex@example.com>", cc: '"Shah, Priya" <priya@acme.example>' });
  await item("gm:2", "google", "email", { from: "Alex <alex@example.com>", to: "Tom Keller <tom@acme.example>", sent: true });
  await item("wa:1", "whatsapp", "chat", { chat: "Inês Moreno", participants: ["Inês Moreno", "Alex"] });
  await item("cal:1", "google", "event", { attendees: ["tom@acme.example", "alex@example.com"] });
  await item("sl:1", "slack", "message", { channelId: "C1", user: "U9" });

  const memory = (kind: string, subject: string, text: string, extra = "") =>
    sql`
      insert into memories (user_id, kind, subject, subject_key, text, origin, forgotten_at, forgotten_reason)
      values (${user}, ${kind}, ${subject}, ${subjectKeyOf(subject)}, ${text}, 'import',
              ${extra === "tomb" ? new Date().toISOString() : null}, ${extra === "tomb" ? "user" : null})
      returning id
    `;
  return {
    ines: (await memory("person", "Inês Moreno", "Inês Moreno is Alex's sister."))[0].id,
    tom: (await memory("person", "Tom Keller", "Tom Keller runs the Atlas kickoff."))[0].id,
    marta: (await memory("person", "Marta", "Marta works in finance."))[0].id,
    atlas: (await memory("project", "Atlas", "Atlas is the onboarding redesign."))[0].id,
    atlas2: (await memory("project", "Atlas", "Atlas launches on October 15."))[0].id,
    fact: (await memory("fact", "Atlas", "Atlas has three pricing tiers."))[0].id,
    tomb: (await memory("project", "Secret plan", "", "tomb"))[0].id,
  };
}

describe("migration 026 entities", () => {
  it("backfills people from participants and links person and project memories by subject_key", async () => {
    const { db, sql } = await migratedDb({ before: MIGRATION });
    const user = await createUser(sql);
    const m = await seedOldShape(sql, user);

    await applyMigrations(db, { from: MIGRATION, before: NEXT });

    const aliases = await sql`
      select a.alias, a.source, e.name, e.kind, e.is_self from entity_aliases a join entities e on e.id = a.entity_id
      where a.user_id = ${user} order by a.alias
    `;
    const byAlias = Object.fromEntries(aliases.map((a) => [a.alias, a]));
    // D6: the WhatsApp contact and the mail display name are exactly the same name.
    expect(byAlias["whatsapp:inês moreno"].name).toBe("Inês Moreno");
    expect(byAlias["whatsapp:inês moreno"].source).toBe("name");
    const [{ n: ines }] = await sql`select count(distinct entity_id)::int as n from entity_aliases where alias in ('ines@mail.example', 'whatsapp:inês moreno') and user_id = ${user}`;
    expect(ines).toBe(1);
    // A quoted display name with a comma keeps its name; an address seen only on an event or
    // Slack still gets a person.
    expect(byAlias["priya@acme.example"].name).toBe("Shah, Priya");
    expect(byAlias["tom@acme.example"].name).toBe("Tom Keller");
    expect(byAlias["slack:u9"] ?? byAlias["slack:U9"]).toBeTruthy();

    const roles = await sql`
      select ci.external_id, e.name, ie.role from item_entities ie join context_items ci on ci.id = ie.context_item_id join entities e on e.id = ie.entity_id
      where ie.user_id = ${user} and e.name in ('Inês Moreno', 'Tom Keller') order by ci.external_id, e.name
    `;
    expect(roles.map((r) => `${r.external_id} ${r.name} ${r.role}`)).toEqual([
      "cal:1 Tom Keller to",
      "gm:1 Inês Moreno from",
      "gm:2 Tom Keller to",
      "wa:1 Inês Moreno from",
    ]);

    const memories = await sql`
      select m.id, e.kind, e.name, e.status from memories m left join entities e on e.id = m.entity_id where m.user_id = ${user}
    `;
    const linked = Object.fromEntries(memories.map((r) => [String(r.id), r]));
    // A person memory joins the one person of that name, made from their mail and chats.
    expect(linked[m.ines].name).toBe("Inês Moreno");
    expect(linked[m.tom].name).toBe("Tom Keller");
    expect((await sql`select count(*)::int as n from entities where user_id = ${user} and name_key = 'tom keller'`)[0].n).toBe(1);
    // A person nobody wrote to or from is made from the memory.
    expect(linked[m.marta]).toMatchObject({ kind: "person", name: "Marta" });
    // One project for two memories of the same subject, active; other kinds and tombstones stay unlinked.
    expect(linked[m.atlas]).toMatchObject({ kind: "project", name: "Atlas", status: "active" });
    expect(linked[m.atlas2].name).toBe("Atlas");
    expect(linked[m.fact].kind).toBeNull();
    expect(linked[m.tomb].kind).toBeNull();
    expect((await sql`select count(*)::int as n from entities where user_id = ${user} and kind = 'project'`)[0].n).toBe(1);

    // Both queues now take notes.
    for (const name of ["context_items_unembedded", "context_items_unannotated"]) {
      const [index] = await sql`select indexdef from pg_indexes where indexname = ${name}`;
      expect(index.indexdef).toContain("'note'");
    }
  }, 60000);

  it("leaves a person memory unlinked when two people share its name", async () => {
    const { db, sql } = await migratedDb({ before: MIGRATION });
    const user = await createUser(sql);
    for (const [ext, from] of [["gm:1", "Sam Lee <sam@one.example>"], ["gm:2", "Sam Lee <sam@two.example>"]]) {
      const meta = { from, to: "Alex <alex@example.com>" };
      await sql`
        insert into context_items (user_id, provider, external_id, ts, kind, title, body, meta, participants)
        values (${user}, 'google', ${ext}, now(), 'email', 't', 'b', ${JSON.stringify(meta)}::jsonb, ${participantsOf("google", "email", meta)}::text[])
      `;
    }
    await sql`insert into memories (user_id, kind, subject, subject_key, text, origin) values (${user}, 'person', 'Sam Lee', 'sam lee', 'Sam Lee plays padel.', 'import')`;

    await applyMigrations(db, { from: MIGRATION, before: NEXT });

    expect((await sql`select entity_id from memories where user_id = ${user}`)[0].entity_id).toBeNull();
    expect((await sql`select count(*)::int as n from entities where user_id = ${user} and name_key = 'sam lee'`)[0].n).toBe(2);
  }, 60000);

  it("gives the same people as the insert path for the same items", async () => {
    const { db, sql } = await migratedDb({ before: MIGRATION });
    const old = await createUser(sql);
    await seedOldShape(sql, old);
    await applyMigrations(db, { from: MIGRATION, before: NEXT });

    state.t = { db, sql };
    const fresh = await createUser(sql);
    await insertContextItems(fresh, "google", null, [
      { externalId: "gm:1", ts: new Date().toISOString(), kind: "email", title: "t", body: "b", url: null, meta: { from: "Inês Moreno <ines@mail.example>", to: "Alex <alex@example.com>", cc: '"Shah, Priya" <priya@acme.example>' } },
      { externalId: "gm:2", ts: new Date().toISOString(), kind: "email", title: "t", body: "b", url: null, meta: { from: "Alex <alex@example.com>", to: "Tom Keller <tom@acme.example>", sent: true } },
      { externalId: "cal:1", ts: new Date().toISOString(), kind: "event", title: "t", body: "b", url: null, meta: { attendees: ["tom@acme.example", "alex@example.com"] } },
    ]);
    await insertContextItems(fresh, "whatsapp", null, [{ externalId: "wa:1", ts: new Date().toISOString(), kind: "chat", title: "t", body: "b", url: null, meta: { chat: "Inês Moreno", participants: ["Inês Moreno", "Alex"] } }]);
    await insertContextItems(fresh, "slack", null, [{ externalId: "sl:1", ts: new Date().toISOString(), kind: "message", title: "t", body: "b", url: null, meta: { channelId: "C1", user: "U9" } }]);

    const people = async (user: string) =>
      (
        await sql`
          select e.name, array_agg(a.alias order by a.alias) as aliases,
                 (select array_agg(ci.external_id || ' ' || ie.role order by ci.external_id, ie.role) from item_entities ie join context_items ci on ci.id = ie.context_item_id where ie.entity_id = e.id) as items
          from entities e join entity_aliases a on a.entity_id = e.id
          where e.user_id = ${user} and e.kind = 'person'
          group by e.id order by e.name
        `
      ).map((r) => JSON.stringify(r));
    expect(await people(fresh)).toEqual(await people(old));
  }, 60000);
});
