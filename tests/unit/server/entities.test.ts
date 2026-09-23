import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, fakeEmbedding, migratedDb, type TestDb } from "./_pglite";

// Entities (migrations 026 and 028) against a migrated PGlite: participants linked when items are
// stored (link_participants), decision D6's one automatic merge (an exact address; 028 removed the
// name merge) and everything it leaves apart, the person
// themselves, the manual merge, the WhatsApp self name, memory links, person_activity and the
// `person` and `entity` tools. No model is involved; embeddings are the bag-of-words fake.
const state = vi.hoisted(() => ({ t: null as unknown as TestDb }));
vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.t.sql;
  },
}));
vi.mock("@/lib/server/embed", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/embed")>()),
  embedTexts: vi.fn(async (texts: string[]) => texts.map((t) => fakeEmbedding(t))),
  embedOne: vi.fn(async (t: string) => fakeEmbedding(t)),
}));

import { confirmWhatsappSelf, entityContext, linkMemoryEntities, mergeEntities, peopleList, whatsappSelf } from "@/lib/server/entities";
import { ContextRefs } from "@/lib/server/harness/context";
import { TOOLS, type ToolContext } from "@/lib/server/harness/tools";
import { forgetMemory, insertContextItems, removeImport, upsertMemories, type ContextItem } from "@/lib/server/knowledge";

const DAY = 86400_000;
let user: string;

const mail = (id: string, daysAgo: number, from: string, to: string, extra: Record<string, unknown> = {}): ContextItem => ({
  externalId: `gm:${id}`,
  ts: new Date(Date.now() - daysAgo * DAY).toISOString(),
  kind: "email",
  title: `Mail ${id}`,
  body: `Body of ${id}.`,
  url: null,
  meta: { from, to, threadId: `th-${id}`, sent: from.includes("alex@example.com"), ...extra },
});
const chat = (chatName: string, daysAgo: number, participants: string[], body = "hello"): ContextItem => ({
  externalId: `wa:${chatName}:${daysAgo}`,
  ts: new Date(Date.now() - daysAgo * DAY).toISOString(),
  kind: "chat",
  title: `WhatsApp — ${chatName}`,
  body,
  url: null,
  meta: { chat: chatName, participants, messageCount: 2 },
});

async function entityOf(alias: string) {
  const [row] = await state.t.sql`
    select e.id, e.name, e.kind, e.is_self, a.source from entity_aliases a join entities e on e.id = a.entity_id
    where a.user_id = ${user} and a.alias = ${alias}
  `;
  return row ?? null;
}
const aliasesOf = async (entityId: string) =>
  (await state.t.sql`select alias from entity_aliases where entity_id = ${entityId} order by alias`).map((r) => r.alias);
const persons = async () => (await state.t.sql`select name from entities where user_id = ${user} and kind = 'person' and not is_self order by name`).map((r) => r.name);

beforeAll(async () => {
  state.t = await migratedDb();
}, 60000);

beforeEach(async () => {
  user = await createUser(state.t.sql);
});

describe("participants become people when items are stored", () => {
  it("an email and a WhatsApp contact with exactly the same name stay two people, whichever arrives first, until merged by hand", async () => {
    await insertContextItems(user, "google", null, [mail("1", 5, "Inês Moreno <ines@mail.example>", "Alex <alex@example.com>")]);
    await insertContextItems(user, "whatsapp", null, [chat("Inês Moreno", 4, ["Inês Moreno", "Alex"])]);
    const byMail = await entityOf("ines@mail.example");
    const byChat = await entityOf("whatsapp:inês moreno");
    expect(byChat).toMatchObject({ name: "Inês Moreno", source: "participant" });
    expect(byChat.id).not.toBe(byMail.id);
    expect(await aliasesOf(byMail.id)).toEqual(["ines@mail.example"]);

    // The person merges them in the People section.
    expect(await mergeEntities(user, byChat.id, byMail.id)).toBe(true);
    expect(await entityOf("whatsapp:inês moreno")).toMatchObject({ id: byMail.id, source: "merge" });
    expect(await aliasesOf(byMail.id)).toEqual(["ines@mail.example", "whatsapp:inês moreno"]);

    // The other order: the chat first, then a mail whose display name is that contact's name.
    const other = await createUser(state.t.sql);
    await insertContextItems(other, "whatsapp", null, [chat("Marco", 3, ["Marco Tavares", "Alex"])]);
    await insertContextItems(other, "google", null, [mail("2", 2, "Marco Tavares <marco@x.example>", "Alex <alex@example.com>")]);
    const [row] = await state.t.sql`
      select count(distinct entity_id)::int as n from entity_aliases where user_id = ${other} and alias in ('marco@x.example', 'whatsapp:marco tavares')
    `;
    expect(row.n).toBe(2);
  });

  it("links each item to its people as from and to, one entity per exact address", async () => {
    await insertContextItems(user, "google", null, [
      mail("a", 3, "Priya Shah <priya@acme.example>", "Alex <alex@example.com>"),
      mail("b", 2, "Priya S. <PRIYA@acme.example>", "Alex <alex@example.com>, Tom <tom@acme.example>"),
    ]);
    const priya = await entityOf("priya@acme.example");
    expect(priya).toMatchObject({ name: "Priya Shah", kind: "person" });
    const links = await state.t.sql`
      select ci.external_id, ie.role, e.name from item_entities ie join context_items ci on ci.id = ie.context_item_id join entities e on e.id = ie.entity_id
      where ie.user_id = ${user} and not e.is_self order by ci.external_id, e.name
    `;
    expect(links.map((l) => `${l.external_id} ${l.role} ${l.name}`)).toEqual(["gm:a to Alex", "gm:a from Priya Shah", "gm:b to Alex", "gm:b from Priya Shah", "gm:b to Tom"]);
  });

  it("D6: nothing but an exact address merges on its own", async () => {
    await insertContextItems(user, "google", null, [
      mail("1", 9, "Inês Moreno <ines@mail.example>", "Alex <alex@example.com>"),
      mail("2", 8, "Priya Shah <priya@acme.example>", "Alex <alex@example.com>"),
      // Two addresses with one display name are two people until the person says otherwise.
      mail("3", 7, "Sam Lee <sam@one.example>", "Alex <alex@example.com>"),
      mail("4", 6, "Sam Lee <sam@two.example>", "Alex <alex@example.com>"),
    ]);
    await insertContextItems(user, "whatsapp", null, [
      chat("Ines", 5, ["Ines Moreno", "Alex"]), // no accent: not the same name
      chat("Inês", 5, ["Inês Moreno", "Alex"]), // exactly the same name: still not the same address
      chat("Priya", 4, ["Priya", "Alex"]), // a first name only
      chat("Sam", 3, ["Sam Lee", "Alex"]), // matches two people's mail name
    ]);
    const ids = async (...aliases: string[]) => new Set(await Promise.all(aliases.map(async (a) => (await entityOf(a)).id)));
    expect((await ids("ines@mail.example", "whatsapp:ines moreno", "whatsapp:inês moreno")).size).toBe(3);
    expect((await ids("priya@acme.example", "whatsapp:priya")).size).toBe(2);
    expect((await ids("sam@one.example", "sam@two.example", "whatsapp:sam lee")).size).toBe(3);
    // The person's own WhatsApp name is not theirs until they confirm it either.
    expect(await persons()).toEqual(["Alex", "Alex", "Ines Moreno", "Inês Moreno", "Inês Moreno", "Priya", "Priya Shah", "Sam Lee", "Sam Lee", "Sam Lee"]);
    expect((await state.t.sql`select count(*)::int as n from entity_aliases where user_id = ${user} and source <> 'participant'`)[0].n).toBe(0);
  });

  it("the person's own addresses are theirs, and an entity made for one before they connected it is merged in", async () => {
    await insertContextItems(user, "google", null, [mail("1", 3, "Alex <alex@example.com>", "Priya Shah <priya@acme.example>")]);
    expect(await entityOf("alex@example.com")).toMatchObject({ is_self: false });
    await state.t.sql`insert into connections (user_id, provider, account_label, access_token_enc) values (${user}, 'google', 'Alex@Example.com', 'x')`;
    await insertContextItems(user, "google", null, [mail("2", 2, "Priya Shah <priya@acme.example>", "Alex <alex@example.com>")]);
    const self = await entityOf("alex@example.com");
    expect(self).toMatchObject({ is_self: true });
    const [{ n }] = await state.t.sql`select count(*)::int as n from item_entities where entity_id = ${self.id}`;
    expect(n).toBe(2);
    expect(await persons()).toEqual(["Priya Shah"]);
  });
});

describe("the WhatsApp self name", () => {
  it("offers the speakers in every chat and moves the one confirmed to the person, with its chats", async () => {
    await insertContextItems(user, "whatsapp", null, [chat("Marco", 5, ["Marco", "Alex M"]), chat("Inês", 4, ["Inês", "Alex M"]), chat("Inês", 3, ["Inês"])]);
    const asked = await whatsappSelf(user);
    expect(asked).toEqual({ chats: 2, confirmed: null, candidates: [{ name: "Alex M", suggested: false }] });

    expect(await confirmWhatsappSelf(user, "Nobody")).toBe(false);
    expect(await confirmWhatsappSelf(user, "alex m")).toBe(true);
    const self = await entityOf("whatsapp:alex m");
    expect(self).toMatchObject({ is_self: true, source: "confirmed" });
    expect(await persons()).toEqual(["Inês", "Marco"]);
    const [{ n }] = await state.t.sql`select count(*)::int as n from item_entities where entity_id = ${self.id}`;
    expect(n).toBe(2);
    expect((await whatsappSelf(user)).confirmed).toBe("alex m");
    expect((await entityContext(user, 10)).you).toContain("alex m");
  });

  it("with one chat both sides are offered, and a name that matches their own mail name is suggested", async () => {
    await state.t.sql`insert into connections (user_id, provider, account_label, access_token_enc) values (${user}, 'google', 'alex@example.com', 'x')`;
    await insertContextItems(user, "google", null, [mail("1", 3, "Alex Moreno <alex@example.com>", "Marco Tavares <marco@x.example>")]);
    await insertContextItems(user, "whatsapp", null, [chat("Marco", 2, ["Marco Tavares", "Alex Moreno"])]);
    expect((await whatsappSelf(user)).candidates).toEqual([
      { name: "Alex Moreno", suggested: true },
      { name: "Marco Tavares", suggested: false },
    ]);
  });
});

describe("the manual merge", () => {
  it("moves one person's addresses, items and memories to another and deletes it", async () => {
    await insertContextItems(user, "google", null, [mail("1", 3, "Sam Lee <sam@one.example>", "Alex <alex@example.com>"), mail("2", 2, "Sam Lee <sam@two.example>", "Alex <alex@example.com>")]);
    const one = await entityOf("sam@one.example");
    const two = await entityOf("sam@two.example");
    const { idByIndex } = await upsertMemories(user, [{ kind: "person", subject: "Sam Lee", text: "Sam Lee plays padel.", importance: 0.5, confidence: 0.8 }], "import");
    await state.t.sql`update memories set entity_id = ${two.id} where id = ${idByIndex[0]}`;

    expect(await mergeEntities(user, String(two.id), String(one.id))).toBe(true);
    expect(await aliasesOf(one.id)).toEqual(["sam@one.example", "sam@two.example"]);
    expect((await entityOf("sam@two.example")).source).toBe("merge");
    expect((await state.t.sql`select entity_id from memories where id = ${idByIndex[0]}`)[0].entity_id).toBe(one.id);
    expect((await state.t.sql`select count(*)::int as n from item_entities where entity_id = ${one.id}`)[0].n).toBe(2);
    expect((await state.t.sql`select count(*)::int as n from entities where id = ${two.id}`)[0].n).toBe(0);
  });

  it("refuses the person themselves, another account's entity and a different kind", async () => {
    await insertContextItems(user, "google", null, [mail("1", 3, "Sam Lee <sam@one.example>", "Alex <alex@example.com>")]);
    const sam = String((await entityOf("sam@one.example")).id);
    const [self] = await state.t.sql`select id from entities where user_id = ${user} and is_self`;
    const other = await createUser(state.t.sql);
    await insertContextItems(other, "google", null, [mail("9", 3, "Kim <kim@x.example>", "Bo <bo@x.example>")]);
    const [kim] = await state.t.sql`select entity_id as id from entity_aliases where user_id = ${other} and alias = 'kim@x.example'`;
    const [project] = await state.t.sql`insert into entities (user_id, kind, name, name_key, status) values (${user}, 'project', 'Atlas', 'atlas', 'active') returning id`;

    expect(await mergeEntities(user, String(self.id), sam)).toBe(false);
    expect(await mergeEntities(user, String(kim.id), sam)).toBe(false);
    expect(await mergeEntities(user, sam, String(kim.id))).toBe(false);
    expect(await mergeEntities(user, String(project.id), sam)).toBe(false);
  });
});

describe("memories linked to what they are about", () => {
  it("a project is found or made active, and a person is the one on the memory's source item", async () => {
    await insertContextItems(user, "google", null, [mail("1", 3, "Sam Lee <sam@one.example>", "Alex <alex@example.com>"), mail("2", 2, "Sam Lee <sam@two.example>", "Alex <alex@example.com>")]);
    const [item2] = await state.t.sql`select id from context_items where user_id = ${user} and external_id = 'gm:2'`;
    const { idByIndex } = await upsertMemories(
      user,
      [
        { kind: "project", subject: "Atlas", text: "Atlas is the onboarding redesign.", importance: 0.8, confidence: 0.9 },
        { kind: "person", subject: "Sam", text: "Sam Lee plays padel on Wednesdays.", importance: 0.5, confidence: 0.8, source_ids: [item2.id] },
        { kind: "person", subject: "Sam Lee", text: "Sam Lee moved to Porto.", importance: 0.5, confidence: 0.8 },
      ],
      "import"
    );
    const linked = await linkMemoryEntities(user, [
      { memoryId: idByIndex[0], kind: "project", name: "Atlas" },
      { memoryId: idByIndex[1], kind: "person", name: "Sam" },
      { memoryId: idByIndex[2], kind: "person", name: "Sam Lee" },
      { memoryId: idByIndex[0], kind: "wizard", name: "Atlas" },
    ]);
    expect(linked).toBe(2);
    const rows = await state.t.sql`
      select m.id, e.kind, e.name, e.status from memories m left join entities e on e.id = m.entity_id where m.user_id = ${user} order by m.id
    `;
    expect(rows.map((r) => [r.kind, r.name, r.status])).toEqual([
      ["project", "Atlas", "active"],
      // The source item's person, by first name.
      ["person", "Sam Lee", null],
      // Two people named Sam Lee and no item to tell them apart: left unlinked.
      [null, null, null],
    ]);
    expect((await entityOf("sam@two.example")).id).toBe((await state.t.sql`select entity_id from memories where id = ${idByIndex[1]}`)[0].entity_id);
    // The memory's source item is linked to the person it is about.
    const [mention] = await state.t.sql`select role from item_entities where context_item_id = ${item2.id} and role = 'mention'`;
    expect(mention).toBeTruthy();
    // Linking again finds the same project.
    await linkMemoryEntities(user, [{ memoryId: idByIndex[0], kind: "project", name: "atlas" }]);
    expect((await state.t.sql`select count(*)::int as n from entities where user_id = ${user} and kind = 'project'`)[0].n).toBe(1);
  });
});

describe("the person themselves", () => {
  it("takes their mail name, and a memory naming them links to them, never to a second person", async () => {
    await state.t.sql`insert into connections (user_id, provider, account_label, access_token_enc) values (${user}, 'google', 'alex@example.com', 'x')`;
    await insertContextItems(user, "google", null, [mail("1", 3, "Alex Moreno <alex@example.com>", "Priya Shah <priya@acme.example>")]);
    const [self] = await state.t.sql`select id, name from entities where user_id = ${user} and is_self`;
    expect(self.name).toBe("Alex Moreno");
    const { idByIndex } = await upsertMemories(user, [{ kind: "preference", subject: "Alex Moreno", text: "Alex Moreno always wants an aisle seat.", importance: 0.8, confidence: 0.9 }], "chat");
    expect(await linkMemoryEntities(user, [{ memoryId: idByIndex[0], kind: "person", name: "Alex Moreno" }])).toBe(1);
    expect((await state.t.sql`select entity_id from memories where id = ${idByIndex[0]}`)[0].entity_id).toBe(self.id);
    expect(await persons()).toEqual(["Priya Shah"]);
  });
});

describe("person_activity and the People list", () => {
  it("counts contacts each way, the usual gap and the topics on items with them", async () => {
    await state.t.sql`insert into connections (user_id, provider, account_label, access_token_enc) values (${user}, 'google', 'alex@example.com', 'x')`;
    await insertContextItems(user, "google", null, [
      mail("1", 30, "Priya Shah <priya@acme.example>", "Alex <alex@example.com>"),
      mail("2", 20, "Alex <alex@example.com>", "Priya Shah <priya@acme.example>"),
      mail("3", 10, "Priya Shah <priya@acme.example>", "Alex <alex@example.com>"),
      mail("4", 5, "Digest <news@digest.example>", "Alex <alex@example.com>"),
    ]);
    const priya = await entityOf("priya@acme.example");
    const [project] = await state.t.sql`insert into entities (user_id, kind, name, name_key, status) values (${user}, 'project', 'Atlas', 'atlas', 'active') returning id`;
    await state.t.sql`
      insert into item_entities (context_item_id, entity_id, user_id, role)
      select id, ${project.id}, ${user}, 'topic' from context_items where user_id = ${user} and external_id in ('gm:1', 'gm:3')
    `;
    const [a] = await state.t.sql`select * from person_activity where user_id = ${user} and entity_id = ${priya.id}`;
    expect(a).toMatchObject({ items: 3, items_90d: 3, top_topics: ["Atlas"] });
    expect(Math.round(Number(a.median_gap_days))).toBe(10);
    expect(Date.parse(a.last_inbound)).toBeLessThan(Date.now() - 9 * DAY);
    expect(Date.parse(a.last_outbound)).toBeLessThan(Date.now() - 19 * DAY);

    // The newsletter's sender is nobody they are in touch with.
    expect((await peopleList(user)).map((p) => [p.name, p.items, p.topTopics])).toEqual([["Priya Shah", 3, ["Atlas"]]]);
  });
});

describe("the person and entity tools", () => {
  function ctxFor(userAsked = false) {
    const seen = new ContextRefs();
    const ctx: ToolContext = { userId: user, seen, returned: seen, userAsked, refs: { item: (id) => seen.item(id), memory: (id) => seen.memory(id) } };
    return { ctx, seen };
  }
  const call = (name: string, ctx: ToolContext, args: Record<string, unknown>) => TOOLS.get(name)!.handler(ctx, args) as Promise<Record<string, any>>;

  it("person finds one entity by an address or either of its names, with its activity and memories", async () => {
    await insertContextItems(user, "google", null, [
      mail("1", 6, "Inês Moreno <ines@mail.example>", "Alex <alex@example.com>"),
      mail("2", 4, "Alex <alex@example.com>", "Inês Moreno <ines@mail.example>"),
    ]);
    await insertContextItems(user, "whatsapp", null, [chat("Inês Moreno", 2, ["Inês Moreno", "Alex"], "Inês: lunch on Sunday?")]);
    // Her mail and her WhatsApp name, merged by the person (nothing merges them by name).
    await mergeEntities(user, (await entityOf("whatsapp:inês moreno")).id, (await entityOf("ines@mail.example")).id);
    // Annotated and not sensitive, so the tools show them without the person asking (item-signals.ts).
    await state.t.sql`update context_items set signals_at = now(), signals = '{"sensitive": 0.1}'::jsonb where user_id = ${user}`;
    const { idByIndex } = await upsertMemories(
      user,
      [
        { kind: "person", subject: "Inês Moreno", text: "Inês Moreno is Alex's sister.", importance: 0.8, confidence: 0.9 },
        { kind: "fact", subject: "Inês Moreno", text: "Inês Moreno is pregnant.", importance: 0.6, confidence: 0.9, sensitive: true },
      ],
      "import"
    );
    await linkMemoryEntities(user, [{ memoryId: idByIndex[0], kind: "person", name: "Inês Moreno" }]);

    for (const who of ["ines@mail.example", "Inês Moreno", "inês", "whatsapp:inês moreno"]) {
      const { ctx } = ctxFor();
      const out = await call("person", ctx, { who });
      expect(out).toMatchObject({ found: true, name: "Inês Moreno", addresses: ["ines@mail.example", "whatsapp:inês moreno"], items_total: 3, items_90d: 3 });
    }
    const { ctx, seen } = ctxFor();
    const out = await call("person", ctx, { who: "Inês" });
    expect(Date.parse(out.last_contact)).toBeGreaterThan(Date.now() - 3 * DAY);
    expect(out.last_from_you).toBeTruthy();
    // The linked memory, and the unlinked one whose subject is her name; the private one only when asked.
    expect(out.memories.map((m: { ref: string }) => m.ref)).toEqual([`m${idByIndex[0]}`]);
    expect(out.recent.every((r: { ref: string }) => seen.has(r.ref))).toBe(true);
    const asked = await call("person", ctxFor(true).ctx, { who: "Inês" });
    expect(asked.memories.map((m: { ref: string }) => m.ref)).toEqual([`m${idByIndex[0]}`, `m${idByIndex[1]}`]);
    expect(await call("person", ctxFor().ctx, { who: "Nobody at all" })).toMatchObject({ found: false });
  });

  it("entity finds a project by name, with its status and memories", async () => {
    const { idByIndex } = await upsertMemories(user, [{ kind: "project", subject: "Pottery studio", text: "Alex wants to open a pottery studio in Porto.", importance: 0.7, confidence: 0.9 }], "chat");
    await linkMemoryEntities(user, [{ memoryId: idByIndex[0], kind: "idea", name: "Pottery studio" }]);
    const out = await call("entity", ctxFor().ctx, { name: "pottery" });
    expect(out).toMatchObject({ found: true, kind: "idea", name: "Pottery studio", status: "active" });
    expect(out.memories.map((m: { ref: string }) => m.ref)).toEqual([`m${idByIndex[0]}`]);
    expect(await call("entity", ctxFor().ctx, { name: "pottery", kind: "person" })).toMatchObject({ found: false });
  });
});

describe("entities nothing holds up any more", () => {
  it("go when their import is removed or their only memory is forgotten", async () => {
    const [imp] = await state.t.sql`insert into imports (user_id, source, label) values (${user}, 'whatsapp', 'Marco') returning id`;
    await insertContextItems(user, "google", null, [mail("1", 3, "Inês Moreno <ines@mail.example>", "Alex <alex@example.com>")]);
    await insertContextItems(user, "whatsapp", imp.id, [chat("Marco", 2, ["Marco Tavares", "Alex"]), chat("Inês Moreno", 2, ["Inês Moreno"])]);
    const { idByIndex } = await upsertMemories(user, [{ kind: "goal", subject: "Pottery", text: "Alex wants a pottery studio.", importance: 0.7, confidence: 0.9 }], "chat");
    await linkMemoryEntities(user, [{ memoryId: idByIndex[0], kind: "idea", name: "Pottery studio" }]);
    const ines = await entityOf("ines@mail.example");
    expect(await entityOf("whatsapp:inês moreno")).toBeTruthy();

    await removeImport(user, imp.id);
    // Marco and Inês's WhatsApp name were only in that import; Inês keeps her mail.
    expect(await entityOf("whatsapp:marco tavares")).toBeNull();
    expect(await entityOf("whatsapp:inês moreno")).toBeNull();
    expect(await aliasesOf(ines.id)).toEqual(["ines@mail.example"]);

    expect((await state.t.sql`select count(*)::int as n from entities where user_id = ${user} and kind = 'idea'`)[0].n).toBe(1);
    await forgetMemory(user, String(idByIndex[0]));
    expect((await state.t.sql`select count(*)::int as n from entities where user_id = ${user} and kind = 'idea'`)[0].n).toBe(0);
    expect((await state.t.sql`select count(*)::int as n from entities where user_id = ${user} and is_self`)[0].n).toBe(1);
  });
});
