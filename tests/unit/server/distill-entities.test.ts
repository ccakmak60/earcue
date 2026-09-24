import { beforeAll, describe, expect, it, vi } from "vitest";
import { createUser, fakeEmbedding, migratedDb, type TestDb } from "./_pglite";

// Distill creates and links entities (memory architecture plan, Phase 3): the prompt lists the
// known ones by name and the person's own names, each memory may name what it is about, and the
// pass links it (link_memory_entities), making the ones that do not exist yet. The model path is
// the real one; only fetch is stubbed, by a fake that answers from what it was sent.
const state = vi.hoisted(() => ({ t: null as unknown as TestDb }));
vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.t.sql;
  },
}));

import { insertContextItems, runDistillPass } from "@/lib/server/knowledge";

type Json = Record<string, any>;
const prompts: { trusted: Json; untrusted: Json }[] = [];

function partsOf(body: Json) {
  const content = String(body.messages.at(-1).content);
  const block = /<(untrusted_[0-9a-f]+)>\n([\s\S]*?)\n<\/\1>/.exec(content);
  const trusted = /\n\n(\{"containers":[^\n]*\})\n\n/.exec(content);
  return { untrusted: block ? JSON.parse(block[2]) : {}, trusted: trusted ? JSON.parse(trusted[1]) : {} };
}

function reply(body: Json): unknown {
  const required: string[] = body.response_format?.json_schema?.schema?.required ?? [];
  if (required.includes("memories")) {
    const parts = partsOf(body);
    prompts.push(parts);
    const ref = (title: string) => parts.untrusted.items.find((i: Json) => i.title === title).ref;
    const memory = (subject: string, text: string, entity: Json | null, source: string) => ({
      kind: "fact",
      subject,
      text,
      container: "work",
      importance: 0.6,
      confidence: 0.8,
      evidence: [source],
      source_refs: [ref(source)],
      sensitive: false,
      expires_in_days: null,
      relations: [],
      entity,
    });
    return {
      memories: [
        memory("Priya Shah", "Priya Shah leads pricing for Atlas.", { kind: "person", name: "Priya Shah" }, "Pricing tiers"),
        memory("Atlas", "Atlas launches on October 15.", { kind: "project", name: "atlas" }, "Pricing tiers"),
        memory("Surf trip", "Marco and Alex want to go surfing in Ericeira.", { kind: "idea", name: "Surf trip to Ericeira" }, "WhatsApp — Marco"),
        memory("Alex", "Alex prefers morning meetings.", null, "Re: Pricing tiers"),
      ],
    };
  }
  if (required.includes("derived")) return { derived: [] };
  return { summary: "Alex.", static_facts: [], dynamic_facts: [], buckets: { preferences: [], people: [], projects: [], tools: [], routines: [], goals: [] } };
}

beforeAll(async () => {
  state.t = await migratedDb();
  process.env.AZURE_OPENAI_API_KEY = "test-key";
  process.env.AZURE_OPENAI_BASE_URL = "https://test.openai.azure.com/openai/v1";
  process.env.DISTILL_ANNOTATE_WAIT_HOURS = "0";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(input).endsWith("/embeddings")) {
      return Response.json({ data: body.input.map((t: string, index: number) => ({ index, embedding: fakeEmbedding(t) })), usage: { prompt_tokens: 5 } });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(reply(body)) } }], usage: { prompt_tokens: 300, completion_tokens: 40 } });
  });
}, 60000);

describe("distill and entities", () => {
  it("lists the known entities, and links each memory to the one it names, making new ones", async () => {
    const user = await createUser(state.t.sql);
    await state.t.sql`insert into connections (user_id, provider, account_label, access_token_enc) values (${user}, 'google', 'alex@example.com', 'x')`;
    await state.t.sql`insert into entities (user_id, kind, name, name_key, status) values (${user}, 'project', 'Atlas', 'atlas', 'active')`;
    const ts = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    await insertContextItems(user, "google", null, [
      { externalId: "gm:1", ts: ts(5), kind: "email", title: "Pricing tiers", body: "Could you send the Atlas tiers?", url: null, meta: { from: "Priya Shah <priya@acme.example>", to: "Alex Moreno <alex@example.com>", threadId: "t1" } },
      { externalId: "gm:2", ts: ts(4), kind: "email", title: "Re: Pricing tiers", body: "Sending tomorrow morning.", url: null, meta: { from: "Alex Moreno <alex@example.com>", to: "Priya Shah <priya@acme.example>", threadId: "t1", sent: true } },
    ]);
    await insertContextItems(user, "whatsapp", null, [
      { externalId: "wa:1", ts: ts(3), kind: "chat", title: "WhatsApp — Marco", body: "Marco Tavares: Ericeira in October?", url: null, meta: { chat: "Marco", participants: ["Marco Tavares", "Alex Moreno"] } },
    ]);

    const result = await runDistillPass({ id: user, tz: "UTC" }, Date.now() + 60_000);
    expect(result).toMatchObject({ processed: 3, created: 4 });

    const [sent] = prompts;
    // Atlas, Priya (Alex wrote to her) and Marco (a chat contact); Alex's own WhatsApp name joined
    // them by their own mail name (D6), so it is not offered and is among `you`.
    expect(sent.untrusted.entities).toEqual(
      expect.arrayContaining([
        { kind: "project", name: "Atlas" },
        { kind: "person", name: "Priya Shah" },
        { kind: "person", name: "Marco Tavares" },
      ])
    );
    expect(sent.untrusted.entities).toHaveLength(3);
    expect(sent.trusted.you).toEqual(["Alex Moreno"]);

    const rows = await state.t.sql`
      select m.subject, e.kind, e.name, e.status from memories m left join entities e on e.id = m.entity_id
      where m.user_id = ${user} order by m.id
    `;
    expect(rows.map((r) => [r.subject, r.kind, r.name, r.status])).toEqual([
      ["Priya Shah", "person", "Priya Shah", null],
      ["Atlas", "project", "Atlas", "active"],
      ["Surf trip", "idea", "Surf trip to Ericeira", "active"],
      ["Alex", null, null, null],
    ]);
    // The person memory went to the entity her mail made, not a new one, and the items memories
    // were drawn from are linked to what they are about.
    expect((await state.t.sql`select count(*)::int as n from entities where user_id = ${user} and name_key = 'priya shah'`)[0].n).toBe(1);
    const links = await state.t.sql`
      select ci.external_id, e.name, ie.role from item_entities ie join context_items ci on ci.id = ie.context_item_id join entities e on e.id = ie.entity_id
      where ie.user_id = ${user} and ie.role in ('mention', 'topic') order by ci.external_id, e.name
    `;
    expect(links.map((l) => `${l.external_id} ${l.name} ${l.role}`)).toEqual(["gm:1 Atlas topic", "gm:1 Priya Shah mention", "wa:1 Surf trip to Ericeira topic"]);
    const [run] = await state.t.sql`select output from agent_runs where user_id = ${user} and task = 'distill'`;
    expect(run.output).toMatchObject({ entity_links: 3, bad_refs: 0 });
  });
});
