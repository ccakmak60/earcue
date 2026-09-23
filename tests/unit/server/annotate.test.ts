import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, fakeEmbedding, migratedDb, type TestDb } from "./_pglite";

// Item signals (migration 024, annotate.ts, decide.ts) against a migrated PGlite. The model path is
// the real one (chatJson's strict json_schema, conform(), metering, the run row); only fetch is
// stubbed, by a fake model that reads the packed state it was sent and answers from each item's
// own title, so a wrong mapping from an answer back to its item shows up as a wrong row.
const state = vi.hoisted(() => ({ t: null as unknown as TestDb, user: null as unknown }));
vi.mock("@/lib/server/db", () => ({
  get sql() {
    return state.t.sql;
  },
}));
vi.mock("@/lib/server/auth", () => ({ requireAuthed: vi.fn(async () => state.user) }));

import { ANNOTATE_KINDS, ANNOTATE_MAX_ATTEMPTS, ANNOTATE_PROMPT, annotatePendingItems } from "@/lib/server/annotate";
import { QuotaExceeded } from "@/lib/server/errors";
import { handleCatchup } from "@/lib/server/assist/catchup";
import { ContextRefs } from "@/lib/server/harness/context";
import { READ_TOOLS } from "@/lib/server/harness/tools";
import { insertContextItems, threadKeyOf } from "@/lib/server/knowledge";

type Json = Record<string, any>;
interface Sent {
  body: Json;
  items: Json[];
  about: string[];
}
let sent: Sent[] = [];
// How the fake model answers one request; the default labels every item from its title.
let answer: (s: Sent) => unknown = (s) => ({ answers: s.items.map(labelled) });

// "drop …", "key …" and "keep …" titles get that triage; "reply" in the title means a reply is owed.
function labelled(item: Json) {
  const title = String(item.title);
  const triage = title.startsWith("drop") ? "drop" : title.startsWith("key") ? "key" : "keep";
  return { about: item.n, triage, salience: triage === "key" ? 0.9 : triage === "drop" ? 0.05 : 0.4, needs_reply: /reply/.test(title) ? 0.85 : 0.1, commitment: 0.2, sensitive: 0 };
}

function fakeAzure(url: string, init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.endsWith("/embeddings")) {
    return Response.json({ data: body.input.map((t: string, index: number) => ({ index, embedding: fakeEmbedding(t) })), usage: { prompt_tokens: 5 } });
  }
  const content = String(body.messages.at(-1).content);
  const block = /<(untrusted_[0-9a-f]+)>\n([\s\S]*?)\n<\/\1>/.exec(content);
  const trusted = /\n\n(\{"about":[^\n]*\})\n\n/.exec(content);
  const s: Sent = { body, items: block ? JSON.parse(block[2]).items : [], about: trusted ? JSON.parse(trusted[1]).about : [] };
  sent.push(s);
  const reply = answer(s);
  return Response.json({ choices: [{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } }], usage: { prompt_tokens: 300, completion_tokens: 40 } });
}

const PRO = (id: string) => ({ id, tz: "UTC", plan: "pro" });
const later = () => Date.now() + 60_000;

async function seedMail(userId: string, titles: string[], thread = (i: number) => `th-${i}`) {
  await insertContextItems(
    userId,
    "google",
    null,
    titles.map((title, i) => ({
      externalId: `gm:${title}:${i}`,
      ts: new Date(Date.parse("2026-09-20T09:00:00Z") + i * 60_000).toISOString(),
      kind: "email",
      title,
      body: `Body of ${title}.`,
      url: null,
      meta: { from: "Priya <priya@acme.example>", to: "Alex <alex@example.com>", threadId: thread(i), sent: false },
    }))
  );
}

async function signals(userId: string) {
  return state.t.sql`
    select title, triage, salience, needs_reply, commitment, signals, signals_model, signals_at is not null as done
    from context_items where user_id = ${userId} order by id
  `;
}

beforeAll(async () => {
  state.t = await migratedDb();
  process.env.AZURE_OPENAI_API_KEY = "test-key";
  process.env.AZURE_OPENAI_BASE_URL = "https://test.openai.azure.com/openai/v1";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => fakeAzure(String(input), init));
}, 60000);

beforeEach(() => {
  sent = [];
  answer = (s) => ({ answers: s.items.map(labelled) });
});

afterEach(() => {
  delete process.env.ANNOTATE_PACK;
  delete process.env.MODEL_ANNOTATE;
});

const TITLES = Array.from({ length: 25 }, (_, i) => `${["drop", "keep", "key"][i % 3]} item ${i}${i % 4 === 0 ? " needs a reply" : ""}`);

describe("packing", () => {
  it("maps every packed answer back to its own item, whatever order the model answers in", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, TITLES);
    process.env.ANNOTATE_PACK = "10";
    answer = (s) => ({ answers: s.items.map(labelled).reverse() });

    const result = await annotatePendingItems(PRO(user), 25, later());

    expect(result).toEqual({ annotated: 25, missing: 0, calls: 3 });
    expect(sent.map((s) => s.items.length)).toEqual([10, 10, 5]);
    // Newest first, numbered from 1 in each pack.
    expect(sent[0].items.map((i) => i.n)).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)));
    expect(sent[0].items[0].title).toBe(TITLES[24]);
    for (const row of await signals(user)) {
      const want = labelled({ title: row.title, n: "" });
      expect(row).toMatchObject({ triage: want.triage, done: true, signals_model: "earcue-reason", signals: { sensitive: 0 } });
      expect(row.needs_reply).toBeCloseTo(want.needs_reply);
      expect(row.salience).toBeCloseTo(want.salience);
    }
  });

  it("runs at most three packs at once, and a failed call lets the ones in flight finish before it throws", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, Array.from({ length: 60 }, (_, i) => `keep item ${i}`));
    process.env.ANNOTATE_PACK = "10";
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const n = ++calls;
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return n === 2 ? new Response("bad request", { status: 400 }) : fakeAzure(String(input), init);
    });

    try {
      await expect(annotatePendingItems(PRO(user), 60, later())).rejects.toThrow();
    } finally {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => fakeAzure(String(input), init));
    }

    // Three packs started together and the second failed. A worker may already have taken its next
    // pack before the failure surfaced, but not all six ran; every answered pack was stored and the
    // failed one's items were left untouched.
    expect(peak).toBe(3);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(calls).toBeLessThan(6);
    const [counts] = await state.t.sql`
      select count(*) filter (where signals_at is not null)::int as done, count(*) filter (where signals is not null)::int as touched
      from context_items where user_id = ${user}
    `;
    expect(counts).toEqual({ done: (calls - 1) * 10, touched: (calls - 1) * 10 });
    const [run] = await state.t.sql`select outcome, output from agent_runs where user_id = ${user}`;
    expect(run).toMatchObject({ outcome: "error", output: { annotated: (calls - 1) * 10, calls } });
  });

  it("stores the same signals packed twenty to a call as one item per call", async () => {
    const packed = await createUser(state.t.sql);
    const single = await createUser(state.t.sql);
    await seedMail(packed, TITLES);
    await seedMail(single, TITLES);

    await annotatePendingItems(PRO(packed), 25, later());
    const packedCalls = sent.length;
    process.env.ANNOTATE_PACK = "1";
    await annotatePendingItems(PRO(single), 25, later());

    expect(packedCalls).toBe(2);
    expect(sent.length - packedCalls).toBe(25);
    const strip = (rows: Json[]) => rows.map(({ title, triage, salience, needs_reply, commitment, signals }) => ({ title, triage, salience, needs_reply, commitment, signals }));
    expect(strip(await signals(single))).toEqual(strip(await signals(packed)));
  });
});

describe("the Azure path", () => {
  it("asks for a strict schema of enums and numbers on MODEL_ANNOTATE, metered to the user, as one annotate run", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["key reply owed", "drop receipt"]);
    process.env.MODEL_ANNOTATE = "earcue-annotate";

    await annotatePendingItems(PRO(user), 20, later());

    const { body } = sent[0];
    expect(body.model).toBe("earcue-annotate");
    const item = body.response_format.json_schema.schema.properties.answers.items;
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(item.properties.about.enum).toEqual(["1", "2"]);
    expect(item.properties.triage.enum).toEqual(["drop", "keep", "key"]);
    for (const key of ["salience", "needs_reply", "commitment", "sensitive"]) expect(item.properties[key].type).toBe("number");
    expect(item.required).toEqual(["about", "triage", "salience", "needs_reply", "commitment", "sensitive"]);
    // The items are imported content: inside the untrusted block, with direction and people.
    expect(sent[0].items[0]).toMatchObject({ n: "1", source: "google", kind: "email", from: "Priya <priya@acme.example>", sent: false, title: "drop receipt" });

    const [usage] = await state.t.sql`select model, user_id, requests from llm_usage_daily where user_id = ${user}`;
    expect(usage).toMatchObject({ model: "earcue-annotate", requests: 1 });
    const [run] = await state.t.sql`select task, prompt_version, model, outcome, steps, input_refs, output from agent_runs where user_id = ${user}`;
    const ids = (await state.t.sql`select id from context_items where user_id = ${user} order by id desc`).map((r) => Number(r.id));
    expect(run).toMatchObject({ task: "annotate", prompt_version: ANNOTATE_PROMPT.version, model: "earcue-annotate", outcome: "ok", steps: 1 });
    expect(run.input_refs).toEqual({ items: ids });
    expect(run.output).toMatchObject({ annotated: 2, missing: 0, calls: 1, triage: { key: 1, drop: 1 } });
    expect(JSON.stringify(run)).not.toContain("receipt");
    expect((await signals(user)).every((r) => r.signals_model === "earcue-annotate")).toBe(true);
  });

  it("leaves an item the model skipped, or answered off the scale, pending with its attempts counted", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["keep a", "keep b", "keep c"]);
    answer = (s) => ({
      answers: s.items.flatMap((i) => (i.title === "keep a" ? [] : i.title === "keep b" ? [{ ...labelled(i), needs_reply: 1.5 }] : [labelled(i), { ...labelled(i), triage: "drop" }])),
    });

    const result = await annotatePendingItems(PRO(user), 20, later());

    expect(result).toEqual({ annotated: 1, missing: 2, calls: 1 });
    const rows = await signals(user);
    expect(rows.map((r) => [r.title, r.triage, r.done, r.signals])).toEqual([
      ["keep a", null, false, { attempts: 1 }],
      ["keep b", null, false, { attempts: 1 }],
      // A second answer for the same item is ignored: the first one stands.
      ["keep c", "keep", true, { sensitive: 0 }],
    ]);
    const [run] = await state.t.sql`select outcome, output from agent_runs where user_id = ${user}`;
    expect(run).toMatchObject({ outcome: "ok", output: { range_dropped: 1, missing: 2 } });
  });

  it("stops asking about an item after three answered calls that left it out", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["keep skipped", "keep fine"]);
    answer = (s) => ({ answers: s.items.filter((i) => i.title !== "keep skipped").map(labelled) });

    for (let i = 0; i < ANNOTATE_MAX_ATTEMPTS + 1; i++) await annotatePendingItems(PRO(user), 20, later());

    expect(sent.map((s) => s.items.map((i) => i.title))).toEqual([["keep fine", "keep skipped"], ["keep skipped"], ["keep skipped"]]);
    expect((await signals(user))[0].signals).toEqual({ attempts: ANNOTATE_MAX_ATTEMPTS });
  });

  it("counts an answer that is not JSON even after the nudge against every item in the pack", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["keep a", "keep b"]);
    answer = () => "I think these are both fine.";

    const result = await annotatePendingItems(PRO(user), 20, later());

    expect(result).toEqual({ annotated: 0, missing: 2, calls: 1 });
    expect(sent).toHaveLength(2);
    expect((await signals(user)).map((r) => r.signals)).toEqual([{ attempts: 1 }, { attempts: 1 }]);
    const [run] = await state.t.sql`select outcome, output from agent_runs where user_id = ${user}`;
    expect(run).toMatchObject({ outcome: "invalid", output: { invalid_calls: 1 } });
  });

  it("charges the annotations metric and refuses past its cap before any model call", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["keep a", "keep b"]);

    await expect(annotatePendingItems({ id: user, tz: "UTC", plan: "none" }, 20, later())).rejects.toBeInstanceOf(QuotaExceeded);
    expect(sent).toHaveLength(0);
    expect(await state.t.sql`select 1 from agent_runs where user_id = ${user}`).toEqual([]);

    await annotatePendingItems(PRO(user), 20, later());
    const [usage] = await state.t.sql`select annotations from usage_daily where user_id = ${user}`;
    // The refused attempt is counted too, as consume() counts every metric.
    expect(usage.annotations).toBe(4);
  });
});

describe("the queue", () => {
  it("drains through context_items_unannotated, which the pending lookup uses", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, TITLES);
    await insertContextItems(user, "browser", null, [
      { externalId: "bh:1", ts: new Date().toISOString(), kind: "page", title: "A visited page", body: "example.com — visited 3×", url: "https://example.com", meta: {} },
    ]);

    const pending = () => state.t.sql`select count(*)::int as n from context_items where user_id = ${user} and signals_at is null and kind = any(${ANNOTATE_KINDS}::text[])`;
    expect((await pending())[0].n).toBe(25);
    await annotatePendingItems(PRO(user), 20, later());
    expect((await pending())[0].n).toBe(5);
    await annotatePendingItems(PRO(user), 20, later());
    expect((await pending())[0].n).toBe(0);
    expect(await annotatePendingItems(PRO(user), 20, later())).toEqual({ annotated: 0, missing: 0, calls: 0 });
    // A bare history row is never annotated.
    expect(await state.t.sql`select signals_at from context_items where user_id = ${user} and kind = 'page'`).toEqual([{ signals_at: null }]);

    await state.t.db.exec("set enable_seqscan = off");
    const plan = await state.t.db.query<{ "QUERY PLAN": string }>(
      "explain select id from context_items where user_id = $1 and signals_at is null and kind = any($2::text[]) order by id desc limit 20",
      [user, ANNOTATE_KINDS]
    );
    await state.t.db.exec("set enable_seqscan = on");
    expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("context_items_unannotated");
  });

  it("puts an item whose text changed back in the queue, and keeps one re-imported unchanged", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["key a", "keep b"]);
    await annotatePendingItems(PRO(user), 20, later());

    await insertContextItems(user, "google", null, [
      { externalId: "gm:key a:0", ts: "2026-09-20T09:00:00Z", kind: "email", title: "key a", body: "A longer body now.", url: null, meta: { threadId: "th-0" } },
      { externalId: "gm:keep b:1", ts: "2026-09-20T09:01:00Z", kind: "email", title: "keep b", body: "Body of keep b.", url: null, meta: { threadId: "th-1" } },
    ]);

    const rows = await signals(user);
    expect(rows.map((r) => [r.title, r.done, r.triage])).toEqual([
      ["key a", false, "key"],
      ["keep b", true, "keep"],
    ]);
  });
});

describe("catch-up", () => {
  it("reports pending annotation, and distill due only once annotation has made the item ready", async () => {
    const user = await createUser(state.t.sql);
    await seedMail(user, ["keep a"]);
    await state.t.sql`update context_items set embedding = array_fill(0, array[768])::vector where user_id = ${user}`;
    state.user = { id: user, tz: "UTC", plan: "pro", unlimited: false };

    const plan = async () => (await handleCatchup(new Request("http://x/api/assist/catchup"))).json();
    // The new mail waits for its signals, so a distill pass now would have nothing to take.
    expect(await plan()).toMatchObject({ distillDue: false, annotateDue: true });
    await annotatePendingItems(PRO(user), 20, later());
    expect(await plan()).toMatchObject({ distillDue: true, annotateDue: false });
    await state.t.sql`update context_items set distilled_at = now() where user_id = ${user}`;
    expect(await plan()).toMatchObject({ distillDue: false, annotateDue: false });
  });
});

describe("thread_key", () => {
  it("keys Gmail threads, WhatsApp chats and Slack threads, and nothing else", async () => {
    expect(threadKeyOf("google", "gm:1", { threadId: "18c2" })).toBe("gm:18c2");
    expect(threadKeyOf("whatsapp", "wa:x", { chat: "Marco Tavares" })).toMatch(/^wa:[0-9a-f]{32}$/);
    expect(threadKeyOf("whatsapp", "wa:y", { chat: "Marco Tavares" })).toBe(threadKeyOf("whatsapp", "wa:x", { chat: "Marco Tavares" }));
    expect(threadKeyOf("slack", "C1:1700.1", { channelId: "C1", threadTs: null })).toBe("slack:C1:1700.1");
    expect(threadKeyOf("slack", "C1:1700.2", { channelId: "C1", threadTs: "1700.1" })).toBe("slack:C1:1700.1");
    expect(threadKeyOf("google", "gcal:1", {})).toBeNull();
    expect(threadKeyOf("upload", "doc:a:1:0", { part: 1 })).toBeNull();
  });

  it("is stored on insert, so the thread tool finds a Slack reply from its parent", async () => {
    const user = await createUser(state.t.sql);
    await insertContextItems(user, "slack", null, [
      { externalId: "C1:1700.1", ts: "2026-09-20T09:00:00Z", kind: "message", title: "#atlas", body: "Can someone own the launch copy?", url: null, meta: { channelId: "C1", threadTs: null } },
      { externalId: "C1:1700.2", ts: "2026-09-20T09:05:00Z", kind: "message", title: "#atlas", body: "I will, by Friday.", url: null, meta: { channelId: "C1", threadTs: "1700.1" } },
      { externalId: "C1:1700.3", ts: "2026-09-20T09:06:00Z", kind: "message", title: "#atlas", body: "Unrelated.", url: null, meta: { channelId: "C1", threadTs: null } },
    ]);
    const rows = await state.t.sql`select id, thread_key from context_items where user_id = ${user} order by id`;
    expect(rows.map((r) => r.thread_key)).toEqual(["slack:C1:1700.1", "slack:C1:1700.1", "slack:C1:1700.3"]);

    const seen = new ContextRefs();
    const thread = READ_TOOLS.find((t) => t.name === "thread")!;
    const ctx = { userId: user, seen, returned: seen, userAsked: false, refs: { item: (id: unknown) => seen.item(id), memory: (id: unknown) => seen.memory(id) } };
    const result = (await thread.handler(ctx, { ref: seen.item(rows[0].id) })) as { items: Json[] };
    expect(result.items.map((i) => i.body)).toEqual(["I will, by Friday."]);
  });
});
