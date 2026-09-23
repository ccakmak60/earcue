import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, fakeEmbedding, migratedDb, type TestDb } from "./_pglite";

// Gate and group (memory architecture plan, Phase 2; migration 025): distill takes annotated items
// key first, then keep by salience, drop last (or never, TRIAGE_GATE=hard), whole conversations
// together, and marks each item distilled; items still waiting for signals are taken after
// DISTILL_ANNOTATE_WAIT_HOURS. The model path is the real one (chatJson, conform, the run row);
// only fetch is stubbed, by a fake model that labels annotate items from their titles and distills
// one memory per item it is sent, sourced from that item.
const state = vi.hoisted(() => ({ t: null as unknown as TestDb, user: null as unknown }));
vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.t.sql;
  },
}));
vi.mock("@/lib/server/auth", () => ({ requireAuthed: vi.fn(async () => state.user) }));

import { POST as assistPOST } from "@/app/api/assist/[action]/route";
import { annotatePendingItems } from "@/lib/server/annotate";
import { handleCatchup } from "@/lib/server/assist/catchup";
import { distillBacklog, insertContextItems, runDistillPass } from "@/lib/server/knowledge";

type Json = Record<string, any>;
// The items each distill request was sent, in order.
let distilled: Json[][] = [];

function untrustedOf(body: Json): Json {
  const content = String(body.messages.at(-1).content);
  const block = /<(untrusted_[0-9a-f]+)>\n([\s\S]*?)\n<\/\1>/.exec(content);
  return block ? JSON.parse(block[2]) : {};
}

// "drop …", "key …" and "keep …" titles get that triage; "high" in the title means salience 0.9.
function labelled(item: Json) {
  const title = String(item.title);
  const triage = title.startsWith("drop") ? "drop" : title.startsWith("key") ? "key" : "keep";
  return { about: item.n, triage, salience: /high/.test(title) ? 0.9 : 0.4, needs_reply: 0.1, commitment: 0, sensitive: 0 };
}

function reply(body: Json): unknown {
  const required: string[] = body.response_format?.json_schema?.schema?.required ?? [];
  if (required.includes("answers")) return { answers: untrustedOf(body).items.map(labelled) };
  if (required.includes("memories")) {
    const items: Json[] = untrustedOf(body).items;
    distilled.push(items);
    return {
      memories: items.map((i) => ({
        kind: "fact",
        subject: i.title,
        text: `Learned ${i.body.slice(0, 80)}`,
        container: "self",
        importance: 0.5,
        confidence: 0.8,
        evidence: [i.title],
        source_refs: [i.ref],
        sensitive: false,
        expires_in_days: null,
        relations: [],
      })),
    };
  }
  if (required.includes("derived")) return { derived: [] };
  return { summary: "Alex.", static_facts: [], dynamic_facts: [], buckets: { preferences: [], people: [], projects: [], tools: [], routines: [], goals: [] } };
}

function fakeAzure(url: string, init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.endsWith("/embeddings")) {
    return Response.json({ data: body.input.map((t: string, index: number) => ({ index, embedding: fakeEmbedding(t) })), usage: { prompt_tokens: 5 } });
  }
  return Response.json({ choices: [{ message: { content: JSON.stringify(reply(body)) } }], usage: { prompt_tokens: 300, completion_tokens: 40 } });
}

const PRO = (id: string) => ({ id, tz: "UTC", plan: "pro" });
const later = () => Date.now() + 60_000;
// Words no other item shares, so the fake embeddings keep every item's memory distinct.
const words = (title: string) =>
  Array.from({ length: 6 }, (_, j) => `${title.replace(/\W+/g, "")}w${j}`).join(" ");

// One email per title, in id order (the first is the oldest), each on its own thread unless given one.
async function seedMail(userId: string, titles: string[], opts: { thread?: (i: number) => string; body?: (title: string) => string } = {}) {
  await insertContextItems(
    userId,
    "google",
    null,
    titles.map((title, i) => ({
      externalId: `gm:${title}`,
      ts: new Date(Date.parse("2026-09-20T09:00:00Z") + i * 60_000).toISOString(),
      kind: "email",
      title,
      body: opts.body ? opts.body(title) : `About ${title}: ${words(title)}.`,
      url: null,
      meta: { from: "Priya <priya@acme.example>", to: "Alex <alex@example.com>", threadId: opts.thread ? opts.thread(i) : `th-${title}`, sent: false },
    }))
  );
}

const pass = (userId: string) => runDistillPass({ id: userId, tz: "UTC" }, later());
const sentTitles = () => distilled.map((batch) => batch.map((i) => i.title));

async function items(userId: string) {
  return state.t.sql`
    select ci.title, ci.distilled_at is not null as distilled, ci.embedding is not null as embedded,
           (select count(*)::int from memory_sources ms where ms.context_item_id = ci.id) as memories
    from context_items ci where ci.user_id = ${userId} order by ci.id
  `;
}

beforeAll(async () => {
  state.t = await migratedDb();
  process.env.AZURE_OPENAI_API_KEY = "test-key";
  process.env.AZURE_OPENAI_BASE_URL = "https://test.openai.azure.com/openai/v1";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => fakeAzure(String(input), init));
}, 60000);

beforeEach(() => {
  distilled = [];
});

afterEach(() => {
  for (const name of ["TRIAGE_GATE", "DISTILL_BATCH", "DISTILL_BATCH_CHARS", "EMBED_ITEMS_PER_PASS", "DISTILL_ANNOTATE_WAIT_HOURS", "ANNOTATE_BATCH"]) delete process.env[name];
});

describe("order", () => {
  it("distills a key item before older keep items, and keep items by salience", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["keep old", "keep high", "keep newer", "key newest"]);
    await annotatePendingItems(PRO(user), 20, later());
    process.env.DISTILL_BATCH = "1";

    for (let i = 0; i < 4; i++) await pass(user);

    expect(sentTitles()).toEqual([["key newest"], ["keep high"], ["keep old"], ["keep newer"]]);
    expect((await items(user)).every((r) => r.distilled && r.memories === 1)).toBe(true);
  });

  it("with the soft gate, distills and embeds a drop item after everything else", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["drop receipt", "keep note", "key request"]);
    await annotatePendingItems(PRO(user), 20, later());
    process.env.DISTILL_BATCH = "1";
    process.env.EMBED_ITEMS_PER_PASS = "1";

    const first = await pass(user);
    expect(first).toMatchObject({ processed: 1, remaining: 2, waiting: 0 });
    expect((await items(user)).map((r) => r.embedded)).toEqual([false, false, true]);
    await pass(user);
    expect((await items(user)).map((r) => r.embedded)).toEqual([false, true, true]);
    const last = await pass(user);

    expect(last).toMatchObject({ processed: 1, remaining: 0 });
    expect(sentTitles()).toEqual([["key request"], ["keep note"], ["drop receipt"]]);
    expect(await items(user)).toEqual([
      { title: "drop receipt", distilled: true, embedded: true, memories: 1 },
      { title: "keep note", distilled: true, embedded: true, memories: 1 },
      { title: "key request", distilled: true, embedded: true, memories: 1 },
    ]);
  });

  it("with the hard gate, gives a drop item no memory and no embedding, and soft takes it back", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["drop receipt", "keep note", "key request"]);
    await annotatePendingItems(PRO(user), 20, later());
    process.env.TRIAGE_GATE = "hard";

    const result = await pass(user);
    await pass(user);

    expect(result).toMatchObject({ processed: 2, remaining: 0, waiting: 0 });
    expect(sentTitles()).toEqual([["key request", "keep note"]]);
    expect(await items(user)).toEqual([
      { title: "drop receipt", distilled: false, embedded: false, memories: 0 },
      { title: "keep note", distilled: true, embedded: true, memories: 1 },
      { title: "key request", distilled: true, embedded: true, memories: 1 },
    ]);
    // Neither catch-up nor the backlog counts it, so hard mode does not keep asking for passes.
    state.user = { id: user, tz: "UTC", plan: "pro", unlimited: false };
    expect(await (await handleCatchup(new Request("http://x/api/assist/catchup"))).json()).toMatchObject({ distillDue: false });
    expect(await distillBacklog(user)).toEqual({ ready: 0, waiting: 0 });

    // Nothing was marked or deleted, so switching back to soft lets the next pass take it.
    process.env.TRIAGE_GATE = "soft";
    await pass(user);
    expect((await items(user))[0]).toEqual({ title: "drop receipt", distilled: true, embedded: true, memories: 1 });
  });
});

describe("grouping", () => {
  it("sends a conversation together at the rank of its best item, oldest first, but never lifts a drop", async () => {
    const user = await createUser(state.t.sql);
    // Thread A: two keep messages, then a key one and an automated drop; b is its own thread.
    const thread = (i: number) => (i === 2 ? "b" : "A");
    await seedMail(user, ["keep a1", "keep a2", "keep high b", "key a3", "drop a4"], { thread });
    await annotatePendingItems(PRO(user), 20, later());

    await pass(user);

    expect(sentTitles()).toEqual([["keep a1", "keep a2", "key a3", "keep high b", "drop a4"]]);
    const [batch] = distilled;
    expect(batch.map((i) => i.thread)).toEqual(["t1", "t1", "t1", "t2", "t1"]);
  });

  it("gives key items up to DISTILL_KEY_CHARS and everything else 600", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["key long", "keep long"], { body: (t) => `${t} `.repeat(600) });
    await annotatePendingItems(PRO(user), 20, later());

    await pass(user);

    expect(distilled[0].map((i) => [i.title, i.body.length])).toEqual([
      ["key long", 2000],
      ["keep long", 600],
    ]);
  });

  it("stops the batch at DISTILL_BATCH_CHARS, always taking one item, and leaves the rest queued", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["key long", "keep a", "keep b"], { body: (t) => `${t} `.repeat(600) });
    await annotatePendingItems(PRO(user), 20, later());
    process.env.DISTILL_BATCH_CHARS = "1300";

    const first = await pass(user);
    const second = await pass(user);

    expect(first).toMatchObject({ processed: 1, remaining: 2 });
    expect(second).toMatchObject({ processed: 2, remaining: 0 });
    expect(sentTitles()).toEqual([["key long"], ["keep a", "keep b"]]);
  });
});

describe("items not yet annotated", () => {
  it("waits for their signals, takes kinds annotate never reads at once, and takes the rest after the wait", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["keep fresh", "keep given up", "keep old"]);
    await insertContextItems(user, "browser", null, [
      { externalId: "bh:1", ts: "2026-09-20T09:00:00Z", kind: "page", title: "A visited page", body: "example.com, visited 3 times", url: "https://example.com", meta: {} },
    ]);

    const first = await pass(user);
    expect(first).toMatchObject({ processed: 1, remaining: 0, waiting: 3 });
    expect(sentTitles()).toEqual([["A visited page"]]);

    // Annotate gave up on one (three answered calls left it out); another has waited a day.
    await state.t.sql`update context_items set signals = '{"attempts": 3}'::jsonb where user_id = ${user} and title = 'keep given up'`;
    await state.t.sql`update context_items set created_at = now() - interval '25 hours' where user_id = ${user} and title = 'keep old'`;
    const second = await pass(user);

    expect(second).toMatchObject({ processed: 2, remaining: 0, waiting: 1 });
    expect(sentTitles()[1]).toEqual(["keep given up", "keep old"]);
    expect((await items(user)).map((r) => [r.title, r.distilled])).toEqual([
      ["keep fresh", false],
      ["keep given up", true],
      ["keep old", true],
      ["A visited page", true],
    ]);

    // Annotation arrives: the waiting item is ready and the next pass takes it.
    await annotatePendingItems(PRO(user), 20, later());
    expect(await pass(user)).toMatchObject({ processed: 1, remaining: 0, waiting: 0 });
  });

  it("puts an item taken unjudged behind every annotated keep item", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["keep unjudged"]);
    await state.t.sql`update context_items set created_at = now() - interval '25 hours' where user_id = ${user}`;
    await seedMail(user, ["keep judged"]);
    await state.t.sql`
      update context_items set triage = 'keep', salience = 0.1, signals = '{}'::jsonb, signals_at = now()
      where user_id = ${user} and title = 'keep judged'
    `;

    await pass(user);

    expect(sentTitles()).toEqual([["keep judged", "keep unjudged"]]);
  });

  it("with the hard gate, embeds an item only once it is judged; with the soft one straight away", async () => {
    const soft = await createUser(state.t.sql);
    const hard = await createUser(state.t.sql);
    await seedMail(soft, ["keep new"]);
    await seedMail(hard, ["keep new"]);

    await pass(soft);
    process.env.TRIAGE_GATE = "hard";
    await pass(hard);

    expect((await items(soft))[0].embedded).toBe(true);
    expect((await items(hard))[0].embedded).toBe(false);
    await annotatePendingItems(PRO(hard), 20, later());
    await pass(hard);
    expect(await items(hard)).toEqual([{ title: "keep new", distilled: true, embedded: true, memories: 1 }]);
  });

  it("with the wait at 0, takes them straight away", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["keep fresh"]);
    process.env.DISTILL_ANNOTATE_WAIT_HOURS = "0";

    expect(await pass(user)).toMatchObject({ processed: 1, waiting: 0 });
  });
});

describe("POST /api/assist/annotate", () => {
  const annotate = (body: unknown) =>
    assistPOST(new Request("http://x/api/assist/annotate", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ action: "annotate" }) });

  it("annotates up to its batch, reports what is left, and then makes distill due", async () => {
    const user = await createUser(state.t.sql);
    state.user = { id: user, tz: "UTC", plan: "pro", unlimited: false };
    await seedMail(user, ["keep a", "keep b", "key c"]);
    await state.t.sql`update context_items set embedding = array_fill(0, array[768])::vector where user_id = ${user}`;
    const plan = async () => (await handleCatchup(new Request("http://x/api/assist/catchup"))).json();
    expect(await plan()).toMatchObject({ annotateDue: true, distillDue: false });

    const first = await annotate({ limit: 2 });
    expect(await first.json()).toEqual({ annotated: 2, missing: 0, calls: 1, remaining: 1 });
    const second = await annotate({});
    expect(await second.json()).toEqual({ annotated: 1, missing: 0, calls: 1, remaining: 0 });
    // Nothing pending: no charge, no run.
    const runs = async () => (await state.t.sql`select count(*)::int as n from agent_runs where user_id = ${user} and task = 'annotate'`)[0].n;
    expect(await runs()).toBe(2);
    expect(await (await annotate({})).json()).toEqual({ annotated: 0, missing: 0, calls: 0, remaining: 0 });
    expect(await runs()).toBe(2);
    const [usage] = await state.t.sql`select annotations from usage_daily where user_id = ${user}`;
    expect(usage.annotations).toBe(3);

    expect(await plan()).toMatchObject({ annotateDue: false, distillDue: true });
  });

  it("does nothing with ANNOTATE_BATCH at 0", async () => {
    const user = await createUser(state.t.sql);
    state.user = { id: user, tz: "UTC", plan: "pro", unlimited: false };
    await seedMail(user, ["keep a"]);
    process.env.ANNOTATE_BATCH = "0";

    expect(await (await annotate({})).json()).toEqual({ annotated: 0, missing: 0, calls: 0, remaining: 1 });
  });
});
