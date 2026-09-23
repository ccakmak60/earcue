import { beforeAll, describe, expect, it, vi } from "vitest";
import { createUser, fakeEmbedding, migratedDb, type TestDb } from "../_pglite";

// The read tools against the migrated schema: what each returns, that its rows go out under refs
// that join the run's sent set, and the sensitivity policy. Embeddings are the bag-of-words fake.
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

import { ContextRefs } from "@/lib/server/harness/context";
import { READ_TOOLS, TOOLS, toolDefinitions, type ToolContext } from "@/lib/server/harness/tools";
import { insertContextItems, upsertMemories } from "@/lib/server/knowledge";

const HOUR = 3600_000;
let user: string;
const ids: Record<string, number> = {};

function ctxFor(userAsked = false) {
  const seen = new ContextRefs();
  const ctx: ToolContext = { userId: user, seen, returned: seen, userAsked, refs: { item: (id) => seen.item(id), memory: (id) => seen.memory(id) } };
  return { ctx, seen };
}

const call = (name: string, ctx: ToolContext, args: Record<string, unknown>) => TOOLS.get(name)!.handler(ctx, args) as Promise<Record<string, any>>;

beforeAll(async () => {
  state.t = await migratedDb();
  user = await createUser(state.t.sql);
  const now = Date.now();
  const email = (id: string, hoursAgo: number, from: string, subject: string, body: string, threadId: string, to = "Alex <alex@example.com>") => ({
    externalId: `gm:${id}`,
    ts: new Date(now - hoursAgo * HOUR).toISOString(),
    kind: "email",
    title: subject,
    body,
    url: null,
    meta: { from, to, threadId, sent: from.includes("alex@") },
  });
  await insertContextItems(user, "google", null, [
    email("p1", 50, "Priya Nair <priya@acme.example>", "Atlas pricing", "Could you send the Atlas pricing tiers by Thursday?", "th-pricing"),
    email("p2", 30, "Alex <alex@example.com>", "Re: Atlas pricing", "Working on the Atlas pricing now.", "th-pricing", "Priya Nair <priya@acme.example>"),
    email("o1", 10, "Tom Berg <tom@acme.example>", "Board deck", "The board deck is due Friday.", "th-board"),
    {
      externalId: "cal:e1",
      ts: new Date(now + 20 * HOUR).toISOString(),
      kind: "event",
      title: "Board meeting",
      body: "Quarterly review",
      url: null,
      meta: { attendees: ["tom@acme.example", "alex@example.com"], location: "Room 4" },
    },
    { externalId: "cal:e2", ts: new Date(now + 40 * 24 * HOUR).toISOString(), kind: "event", title: "Far away", body: "", url: null, meta: {} },
  ]);
  await insertContextItems(user, "whatsapp", null, [
    { externalId: "wa:1", ts: new Date(now - 500 * HOUR).toISOString(), kind: "chat", title: "Marco", body: "Marco: can I borrow the tent", url: null, meta: { chat: "Marco", participants: ["Marco", "Alex"] } },
    { externalId: "wa:2", ts: new Date(now - 400 * HOUR).toISOString(), kind: "chat", title: "Marco", body: "Alex: sure, Saturday", url: null, meta: { chat: "Marco", participants: ["Marco", "Alex"] } },
  ]);
  for (const r of await state.t.sql`select id, external_id from context_items where user_id = ${user}`) ids[r.external_id] = Number(r.id);

  const { idByIndex } = await upsertMemories(
    user,
    [
      { kind: "person", subject: "Priya Nair", text: "Priya Nair runs pricing for Atlas at Acme.", importance: 0.8, confidence: 0.9 },
      { kind: "fact", subject: "Priya Nair", text: "Priya Nair is on medical leave for surgery in October.", importance: 0.6, confidence: 0.9, sensitive: true },
      { kind: "project", subject: "Atlas", text: "Atlas is the product Alex leads, launching with pricing tiers.", importance: 0.9, confidence: 0.9 },
    ],
    "import"
  );
  ids.priya = Number(idByIndex[0]);
  ids.priyaSensitive = Number(idByIndex[1]);
  ids.atlas = Number(idByIndex[2]);
}, 60000);

describe("the registry", () => {
  it("holds the six read tools, none of them writing", () => {
    expect(READ_TOOLS.map((t) => t.name)).toEqual(["recall", "search_items", "thread", "calendar", "person", "entity"]);
    expect(READ_TOOLS.every((t) => !t.writes && t.subrequests > 0 && t.description.length > 0)).toBe(true);
  });

  it("describes each tool as a strict OpenAI function, optional arguments nullable", () => {
    const [recall] = toolDefinitions([TOOLS.get("recall")!]);
    expect(recall).toMatchObject({ type: "function", function: { name: "recall", strict: true } });
    expect(recall.function.parameters).toMatchObject({
      type: "object",
      required: ["query", "container"],
      additionalProperties: false,
      properties: { query: { type: "string" }, container: { type: ["string", "null"] } },
    });
  });
});

describe("recall", () => {
  it("returns memories and documents under refs that join the sent set", async () => {
    const { ctx, seen } = ctxFor();
    const out = await call("recall", ctx, { query: "Atlas pricing" });
    const refs = [...out.memories, ...out.documents].map((r: { ref: string }) => r.ref);
    expect(refs).toContain(`m${ids.atlas}`);
    expect(refs).toContain(`i${ids["gm:p1"]}`);
    expect(refs.every((r) => seen.has(r))).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/"id"/);
  });

  it("leaves sensitive memories out unless the person asked", async () => {
    const sensitiveRef = `m${ids.priyaSensitive}`;
    const pipeline = await call("recall", ctxFor(false).ctx, { query: "Priya Nair medical leave surgery" });
    expect(pipeline.memories.map((m: { ref: string }) => m.ref)).not.toContain(sensitiveRef);
    const asked = await call("recall", ctxFor(true).ctx, { query: "Priya Nair medical leave surgery" });
    expect(asked.memories).toContainEqual(expect.objectContaining({ ref: sensitiveRef, sensitive: true }));
  });
});

describe("search_items", () => {
  it("finds items by words, filtered by provider and days", async () => {
    const { ctx } = ctxFor();
    const all = await call("search_items", ctx, { query: "board deck" });
    expect(all.items.map((i: { ref: string }) => i.ref)).toEqual([`i${ids["gm:o1"]}`]);
    expect(all.items[0]).toMatchObject({ from: "Tom Berg <tom@acme.example>", provider: "google" });
    expect((await call("search_items", ctx, { query: "tent", provider: "google" })).items).toEqual([]);
    expect((await call("search_items", ctx, { query: "tent", provider: "whatsapp", days: 7 })).items).toEqual([]);
    expect((await call("search_items", ctx, { query: "tent", provider: "whatsapp", days: 30 })).items).toHaveLength(1);
  });
});

describe("thread", () => {
  it("returns the rest of a Gmail thread or a WhatsApp chat for a ref the run has seen", async () => {
    const { ctx, seen } = ctxFor();
    seen.item(ids["gm:p2"]);
    const mail = await call("thread", ctx, { ref: `i${ids["gm:p2"]}` });
    expect(mail.items).toEqual([expect.objectContaining({ ref: `i${ids["gm:p1"]}`, from: "Priya Nair <priya@acme.example>", sent: false })]);

    seen.item(ids["wa:1"]);
    const chat = await call("thread", ctx, { ref: `i${ids["wa:1"]}` });
    expect(chat.items.map((i: { ref: string }) => i.ref)).toEqual([`i${ids["wa:2"]}`]);
  });

  it("refuses a ref the run was never shown", async () => {
    const { ctx } = ctxFor();
    expect(await call("thread", ctx, { ref: `i${ids["gm:p2"]}` })).toMatchObject({ error: "unknown_ref" });
    expect(await call("thread", ctx, { ref: `m${ids.atlas}` })).toMatchObject({ error: "unknown_ref" });
  });
});

describe("calendar", () => {
  it("returns events in the range, seven days by default and at most 31", async () => {
    const { ctx } = ctxFor();
    const from = new Date().toISOString();
    const week = await call("calendar", ctx, { from });
    expect(week.events).toEqual([expect.objectContaining({ ref: `i${ids["cal:e1"]}`, title: "Board meeting", location: "Room 4" })]);
    const long = await call("calendar", ctx, { from, to: new Date(Date.now() + 90 * 24 * HOUR).toISOString() });
    expect(long.events).toHaveLength(1);
    expect(Date.parse(long.to) - Date.parse(long.from)).toBe(31 * 24 * HOUR);
    expect(await call("calendar", ctx, { from: "next tuesday" })).toMatchObject({ error: "bad_date" });
  });
});

describe("person", () => {
  it("finds someone by name: their address, memories, recent items and last contact", async () => {
    const { ctx, seen } = ctxFor();
    const out = await call("person", ctx, { who: "priya" });
    expect(out).toMatchObject({ found: true, name: "Priya Nair", addresses: ["priya@acme.example"], items_total: 2 });
    expect(out.recent.map((r: { ref: string }) => r.ref)).toEqual([`i${ids["gm:p2"]}`, `i${ids["gm:p1"]}`]);
    expect(Date.parse(out.last_contact)).toBeGreaterThan(Date.now() - 31 * HOUR);
    expect(out.memories.map((m: { ref: string }) => m.ref)).toEqual([`m${ids.priya}`]);
    expect(seen.has(`m${ids.priya}`) && seen.has(`i${ids["gm:p1"]}`)).toBe(true);
  });

  it("finds someone by address and by a WhatsApp name, and says when nobody matches", async () => {
    const { ctx } = ctxFor();
    expect(await call("person", ctx, { who: "Tom@Acme.example" })).toMatchObject({ found: true, addresses: ["tom@acme.example"], items_total: 2 });
    expect(await call("person", ctx, { who: "marco" })).toMatchObject({ found: true, addresses: ["whatsapp:marco"], items_total: 2 });
    expect(await call("person", ctx, { who: "nobody_%" })).toMatchObject({ found: false });
  });

  it("includes a sensitive memory only when the person asked", async () => {
    const sensitiveRef = `m${ids.priyaSensitive}`;
    expect((await call("person", ctxFor(false).ctx, { who: "Priya" })).memories.map((m: { ref: string }) => m.ref)).not.toContain(sensitiveRef);
    expect((await call("person", ctxFor(true).ctx, { who: "Priya" })).memories.map((m: { ref: string }) => m.ref)).toContain(sensitiveRef);
  });
});
