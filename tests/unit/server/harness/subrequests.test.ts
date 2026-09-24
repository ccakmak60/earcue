import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, fakeEmbedding, migratedDb, type TestDb } from "../_pglite";

// Decision H3: how many subrequests one loop run and one distill pass make, against Workers Free's
// 50 per request. Nothing here runs in workerd, so this counts the calls the code makes: every
// fetch (model calls and embeddings, each a subrequest by Cloudflare's definition) and every `sql`
// call (each opens its own Hyperdrive connection in production; whether those count against the
// 50 is not documented, so both totals are reported). The model, the embeddings and llm_usage_daily
// metering are the real code paths; only fetch is stubbed and Postgres is PGlite.
const count = vi.hoisted(() => ({ fetch: 0, sql: 0, metering: 0, t: null as unknown as TestDb }));
const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("@/lib/server/auth", () => ({
  requireAuthed: vi.fn(async () => auth.user),
  // As auth.ts has it: one update, counted like any other sql call.
  touchTz: vi.fn(async (userId: string, tz: string | null) => {
    if (!tz) return;
    count.sql++;
    await count.t.sql`update users set tz = ${tz} where id = ${userId} and tz <> ${tz}`;
  }),
}));
vi.mock("@/lib/server/db", () => ({
  sql: (strings: TemplateStringsArray, ...params: unknown[]) => {
    count.sql++;
    if (strings.join("?").includes("insert into llm_usage_daily")) count.metering++;
    return count.t.sql(strings, ...params);
  },
}));

import { runLoop } from "@/lib/server/harness/loop";
import { Run } from "@/lib/server/harness/runs";
import { READ_TOOLS, type ToolContext } from "@/lib/server/harness/tools";
import { ContextRefs } from "@/lib/server/harness/context";
import { insertContextItems, runDistillPass, upsertMemories } from "@/lib/server/knowledge";
import { CHAT_PRELUDE_SUBREQUESTS, runChat } from "@/lib/server/assist/chat";
import { consume } from "@/lib/server/quota";
import { ANNOTATE_FIXED_SUBREQUESTS, ANNOTATE_PACK_SUBREQUESTS, annotateBatch, annotatePendingItems } from "@/lib/server/annotate";
import { POST as assistPOST } from "@/app/api/assist/[action]/route";
import { refreshOpenLoops } from "@/lib/server/open-loops";
import {
  BRIEFING_INSERT_SUBREQUESTS,
  BRIEFING_PRELUDE_SUBREQUESTS,
  BRIEFING_READ_SUBREQUESTS,
  RANK_SUBREQUESTS,
  WRITE_CONTEXT_SUBREQUESTS,
} from "@/lib/server/assist/briefing";

type Json = Record<string, any>;
let chatReplies: ((body: Json) => Json)[] = [];

function completion(message: Json): Response {
  return Response.json({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
}

function fakeAzure(url: string, init?: RequestInit): Response {
  count.fetch++;
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.endsWith("/embeddings")) {
    return Response.json({ data: body.input.map((t: string, index: number) => ({ index, embedding: fakeEmbedding(t) })), usage: { prompt_tokens: 5 } });
  }
  const next = chatReplies.shift();
  if (!next) throw new Error("no scripted reply");
  return completion(next(body));
}

const toolCalls = (...calls: [string, Json][]) => () => ({
  content: null,
  tool_calls: calls.map(([name, args], i) => ({ id: `c${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })),
});
const json = (value: unknown) => () => ({ content: JSON.stringify(value) });

let user: string;
const measured: Record<string, { fetch: number; sql: number; metering: number; estimate?: number }> = {};

function snapshot() {
  return { fetch: count.fetch, sql: count.sql, metering: count.metering };
}
function since(before: ReturnType<typeof snapshot>) {
  return { fetch: count.fetch - before.fetch, sql: count.sql - before.sql, metering: count.metering - before.metering };
}

async function seedArchive(userId: string, n: number) {
  const now = Date.now();
  await insertContextItems(
    userId,
    "google",
    null,
    Array.from({ length: n }, (_, i) => ({
      externalId: `gm:${i}`,
      ts: new Date(now - i * 3600_000).toISOString(),
      kind: "email",
      title: `Atlas update ${i}`,
      body: `Priya asked about the Atlas pricing tiers and the board deck, note ${i}.`,
      url: null,
      meta: { from: `Priya Nair <priya@acme.example>`, to: "Alex <alex@example.com>", threadId: `th-${i % 5}`, sent: false },
    }))
  );
}

beforeAll(async () => {
  count.t = await migratedDb();
  process.env.AZURE_OPENAI_API_KEY = "test-key";
  process.env.AZURE_OPENAI_BASE_URL = "https://test.openai.azure.com/openai/v1";
  // On, so the once-per-isolate spend read is counted where it happens.
  process.env.DAILY_TOKEN_CEILING = "1000000000";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => fakeAzure(String(input), init));
  user = await createUser(count.t.sql);
  await seedArchive(user, 40);
}, 60000);

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.DAILY_TOKEN_CEILING;
  console.log(`H3 subrequests (fetch = model and embedding calls; sql = Hyperdrive connections, metering writes included):\n${JSON.stringify(measured, null, 2)}`);
});

beforeEach(() => {
  chatReplies = [];
});

describe("each read tool", () => {
  it("makes no more subrequests than it declares", async () => {
    const seen = new ContextRefs();
    const ctx: ToolContext = { userId: user, seen, returned: seen, userAsked: false, refs: { item: (id) => seen.item(id), memory: (id) => seen.memory(id) } };
    const [first] = await count.t.sql`select id from context_items where user_id = ${user} order by id limit 1`;
    seen.item(first.id);
    const args: Record<string, Json> = {
      recall: { query: "Atlas pricing" },
      search_items: { query: "board deck" },
      thread: { ref: `i${first.id}` },
      calendar: { from: new Date().toISOString() },
      person: { who: "Priya" },
      entity: { name: "Priya Nair" },
      open_loops: {},
    };
    for (const tool of READ_TOOLS) {
      const before = snapshot();
      await tool.handler(ctx, args[tool.name]);
      const used = since(before);
      measured[`tool ${tool.name}`] = used;
      // The spend ceiling's one read per isolate lands on the first embedding; RUN_SUBREQUESTS holds it.
      expect(used.fetch + used.sql - (tool.name === "recall" ? 1 : 0)).toBeLessThanOrEqual(tool.subrequests);
    }
  });
});

describe("one loop run", () => {
  const rounds: [string, Json][][] = [
    [
      ["recall", { query: "Atlas pricing", container: null }],
      ["person", { who: "Priya" }],
    ],
    [
      ["search_items", { query: "board deck", provider: null, days: null }],
      ["calendar", { from: new Date().toISOString(), to: null }],
    ],
    [
      ["recall", { query: "board deck deadline", container: null }],
      ["person", { who: "priya@acme.example" }],
    ],
    [
      ["search_items", { query: "tiers", provider: "google", days: 30 }],
      ["recall", { query: "Priya Nair", container: null }],
    ],
  ];

  async function measure(label: string, steps: number, toolRounds: number, budget: number) {
    chatReplies = [...rounds.slice(0, toolRounds).map((r) => toolCalls(...r)), () => ({ content: "Here is what I found." })];
    const run = new Run(user, "chat", { version: "t", text: "t" }, "earcue-reason");
    const before = snapshot();
    const result = await runLoop({
      run,
      tools: READ_TOOLS,
      messages: [{ role: "user", content: "What does Priya need from me?" }],
      userAsked: true,
      deadline: Date.now() + 60_000,
      maxSteps: steps,
      subrequestBudget: budget,
    });
    const used = since(before);
    measured[label] = { ...used, estimate: result.subrequests };
    expect(result.text).toBe("Here is what I found.");
    expect(run.toolCalls).toHaveLength(toolRounds * 2);
    // The loop's own estimate never undercounts what the code did.
    expect(result.subrequests).toBeGreaterThanOrEqual(used.fetch + used.sql);
    return used;
  }

  it("four steps: three rounds of two tools, then the answer", async () => {
    const used = await measure("loop 4 steps (3 rounds x 2 tools + answer)", 4, 3, 1000);
    expect(used.fetch + used.sql).toBeLessThan(50);
  });

  it("four rounds of two tools, then the answer (five model calls)", async () => {
    await measure("loop 4 rounds x 2 tools + answer (maxSteps 5)", 5, 4, 1000);
  });
});

describe("one chat turn", () => {
  // The request as handleChat runs it after the session: consume() and runChat (the profile read,
  // the run row, the loop and its writes). The better-auth session and the users row come before
  // it and are not counted here; CHAT_PRELUDE_SUBREQUESTS counts them as three.
  let seeded: string;
  beforeAll(async () => {
    const { idByIndex } = await upsertMemories(
      user,
      [{ kind: "person", subject: "Priya Nair", text: "Priya Nair runs pricing for Atlas at Acme.", container: "work", importance: 0.6, confidence: 0.8 }],
      "import"
    );
    seeded = `m${idByIndex[0]}`;
  });

  async function measure(label: string, rounds: [string, Json][][]) {
    chatReplies = [...rounds.map((r) => toolCalls(...r)), () => ({ content: "Done." })];
    const before = snapshot();
    await consume({ id: user, tz: "UTC", plan: "pro", unlimited: false }, "assist_calls", 1);
    const result = await runChat({ id: user, tz: "UTC" }, [{ role: "user", text: "Priya and Atlas pricing" }]);
    const used = since(before);
    const [run] = await count.t.sql`select output, tool_calls from agent_runs where user_id = ${user} and task = 'chat' order by started_at desc limit 1`;
    measured[`chat: ${label}`] = { ...used, estimate: run.output.subrequests };
    expect(result.reply).toBe("Done.");
    expect(run.tool_calls.filter((c: { error?: string }) => c.error)).toEqual([]);
    // The estimate, which starts from the prelude, never undercounts what the code did after it.
    expect(run.output.subrequests - CHAT_PRELUDE_SUBREQUESTS + 2).toBeGreaterThanOrEqual(used.fetch + used.sql);
    return used;
  }

  it("a question: one recall, then the answer", async () => {
    await measure("recall + answer", [[["recall", { query: "Priya pricing", container: null }]]]);
  });

  it("remembering a standing fact", async () => {
    const fact = { text: "Alex prefers aisle seats on flights.", subject: "Flights", kind: "preference", durability: "standing", expires_in_days: null, container: null, sensitive: false };
    await measure("remember + answer", [[["remember", fact]]]);
  });

  // The notes path as built: the turn's message kept as a note, the memory sourced from it and
  // linked to what it is about. Measured from consume(), so the session and users row (three, in
  // CHAT_PRELUDE_SUBREQUESTS) are added to the total.
  it("a note: remembering an idea, then the answer", async () => {
    const idea = { text: "Alex wants to open a pottery studio in Porto.", subject: "Pottery studio", kind: "goal", durability: "standing", expires_in_days: null, container: null, sensitive: false, about: { kind: "idea", name: "Pottery studio" } };
    const used = await measure("note: remember (about an idea) + answer", [[["remember", idea]]]);
    expect(used.fetch + used.sql + 3).toBeLessThanOrEqual(40);
  });

  it("a note with two remembers, one about a person", async () => {
    const used = await measure("note: two remembers (idea, person) + answer", [
      [
        ["remember", { text: "Alex wants to open a pottery studio in Porto.", subject: "Pottery studio", kind: "goal", durability: "standing", expires_in_days: null, container: null, sensitive: false, about: { kind: "idea", name: "Pottery studio" } }],
        ["remember", { text: "Rita would help Alex with the kilns.", subject: "Rita", kind: "person", durability: "standing", expires_in_days: null, container: null, sensitive: false, about: { kind: "person", name: "Rita" } }],
      ],
    ]);
    expect(used.fetch + used.sql + 3).toBeLessThanOrEqual(40);
  });

  it("a forget and a correct after a recall", async () => {
    await measure("recall, then correct + answer", [[["recall", { query: "Priya Nair pricing Atlas", container: null }]], [["correct", { ref: seeded, text: "Priya Nair runs pricing and packaging for Atlas at Acme.", subject: null }]]]);
    await measure("recall, then forget + answer", [[["recall", { query: "Priya Nair pricing packaging Atlas", container: null }]], [["forget", { ref: `m${(await count.t.sql`select max(id) as id from memories where user_id = ${user}`)[0].id}` }]]]);
  });

  it("four steps: two lookups a round, three rounds, then the answer", async () => {
    const used = await measure("4 steps (recall+person, search+calendar, recall+remember) + answer", [
      [["recall", { query: "Atlas pricing", container: null }], ["person", { who: "Priya" }]],
      [["search_items", { query: "board deck", provider: null, days: null }], ["calendar", { from: new Date().toISOString(), to: null }]],
      [["recall", { query: "board deck deadline", container: null }], ["remember", { text: "Alex owes Priya the Atlas pricing tiers by Thursday.", subject: "Priya Nair", kind: "goal", durability: "once", expires_in_days: 3, container: "work", sensitive: false }]],
    ]);
    expect(used.fetch + used.sql + 3).toBeLessThan(50);
  });
});

describe("one distill pass", () => {
  const memories = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      kind: "fact",
      subject: `Subject ${i}`,
      text: `Distinct fact number ${i} about topic ${i * 7919} for Alex.`,
      container: "work",
      importance: 0.5,
      confidence: 0.8,
      evidence: ["Atlas update"],
      source_refs: [],
      sensitive: false,
      expires_in_days: null,
      relations: [],
    }));

  // The pass as runDistillPass runs it: embedding, distill, consolidation and the profile. Since
  // step 7 annotation is its own request (below), so the items arrive annotated, as the client's
  // catch-up leaves them; the pass is what #23 measured.
  for (const n of [5, 10, 25]) {
    it(`with ${n} new memories`, async () => {
      const u = await createUser(count.t.sql);
      await seedArchive(u, 40);
      await count.t.sql`update context_items set triage = 'keep', salience = 0.5, signals = '{}'::jsonb, signals_at = now() where user_id = ${u}`;
      const [{ ids }] = await count.t.sql`select array_agg(id order by id) as ids from context_items where user_id = ${u}`;
      const produced = memories(n).map((m, i) => ({ ...m, source_refs: [`i${ids[i % ids.length]}`, `i${ids[(i + 1) % ids.length]}`] }));
      chatReplies = [
        json({ memories: produced }),
        json({ derived: [] }),
        json({ summary: "Alex leads Atlas.", static_facts: ["Leads Atlas"], dynamic_facts: [], buckets: { preferences: [], people: [], projects: [], tools: [], routines: [], goals: [] } }),
      ];
      const before = snapshot();
      const result = await runDistillPass({ id: u, tz: "UTC" }, Date.now() + 60_000);
      measured[`distill pass, 40 new items, ${n} memories`] = since(before);
      expect(result).toMatchObject({ processed: 40, created: n, remaining: 0, waiting: 0 });
    });
  }
});

// The plan's note path, for comparison with the chat's: one note stored, annotated and distilled in
// one request (the insert, the annotate step, then a whole distill pass with its consolidation and
// profile). Not built; see the notes path in assist/chat.ts.
describe("the plan's note path: annotate and distill one note in one request", () => {
  it("counts what it would take", async () => {
    const u = await createUser(count.t.sql);
    chatReplies = [
      annotateReply,
      json({ memories: [{ kind: "goal", subject: "Pottery studio", text: "Alex wants to open a pottery studio in Porto.", container: "self", importance: 0.7, confidence: 0.9, evidence: ["note"], source_refs: [], sensitive: false, expires_in_days: null, relations: [], entity: { kind: "idea", name: "Pottery studio" } }] }),
      json({ derived: [] }),
      json({ summary: "Alex.", static_facts: [], dynamic_facts: [], buckets: { preferences: [], people: [], projects: [], tools: [], routines: [], goals: [] } }),
    ];
    const before = snapshot();
    await count.t.sql`insert into context_items (user_id, provider, external_id, ts, kind, title, body) values (${u}, 'earcue', 'note:x', now(), 'note', '', 'I want to open a pottery studio in Porto.')`;
    count.sql++;
    await annotatePendingItems({ id: u, tz: "UTC", plan: "pro" }, 1, Date.now() + 60_000);
    const result = await runDistillPass({ id: u, tz: "UTC" }, Date.now() + 60_000);
    const used = since(before);
    measured["plan's note path: insert + annotate + distill pass of one note"] = { ...used, estimate: used.fetch + used.sql + 3 };
    expect(result).toMatchObject({ processed: 1, created: 1 });
  });
});

// A pass with nothing ready: its fixed reads only.
describe("a pass with nothing left to distill", () => {
  it("makes no model call", async () => {
    const u = await createUser(count.t.sql);
    await seedArchive(u, 40);
    await count.t.sql`insert into user_profile (user_id, built_at) values (${u}, now())`;
    await count.t.sql`update context_items set distilled_at = now(), embedding = array_fill(0, array[768])::vector where user_id = ${u}`;
    const before = snapshot();
    const result = await runDistillPass({ id: u, tz: "UTC" }, Date.now() + 60_000);
    measured["idle distill pass"] = since(before);
    expect(result).toMatchObject({ processed: 0, remaining: 0 });
    expect(since(before).fetch).toBe(0);
  });
});

// Answers every item the request's schema asks about.
const annotateReply = (body: Json) => {
  const about: string[] = body.response_format.json_schema.schema.properties.answers.items.properties.about.enum.filter((a: unknown) => a !== null);
  return { content: JSON.stringify({ answers: about.map((n) => ({ about: n, triage: "keep", salience: 0.5, needs_reply: 0.1, commitment: 0, sensitive: 0 })) }) };
};

describe("the annotate step alone", () => {
  // What annotatePendingItems does: the pending read, the `annotations` charge, the entity read,
  // the run row (insert and update), then per packed call one fetch, its metering write and one
  // update.
  for (const [limit, pack] of [[20, 20], [40, 20], [60, 20], [20, 10]] as const) {
    it(`${limit} items, ${pack} to a call`, async () => {
      const u = await createUser(count.t.sql);
      await seedArchive(u, limit);
      chatReplies = Array.from({ length: Math.ceil(limit / pack) }, () => annotateReply);
      process.env.ANNOTATE_PACK = String(pack);
      const before = snapshot();
      const result = await annotatePendingItems({ id: u, tz: "UTC", plan: "pro" }, limit, Date.now() + 60_000);
      delete process.env.ANNOTATE_PACK;
      const used = since(before);
      measured[`annotate step, ${limit} items, ${pack} per call`] = used;
      expect(result).toEqual({ annotated: limit, missing: 0, calls: limit / pack });
      expect(used).toEqual({ fetch: limit / pack, sql: 5 + 2 * (limit / pack), metering: limit / pack });
    });
  }
});

// POST /api/assist/annotate after the session (requireAuthed is mocked, so the session and the users
// row are not counted here; ANNOTATE_FIXED_SUBREQUESTS counts them as three, and the spend ceiling's
// once-per-isolate read as one more).
describe("one annotate request", () => {
  const annotate = () =>
    assistPOST(new Request("http://x/api/assist/annotate", { method: "POST", body: "{}" }), { params: Promise.resolve({ action: "annotate" }) });

  for (const [pending, pack] of [[300, 20], [45, 20], [300, 10]] as const) {
    it(`${pending} pending, ${pack} to a call`, async () => {
      const u = await createUser(count.t.sql);
      await seedArchive(u, pending);
      auth.user = { id: u, tz: "UTC", plan: "pro", unlimited: false };
      process.env.ANNOTATE_PACK = String(pack);
      const batch = annotateBatch();
      const taken = Math.min(pending, batch);
      const packs = Math.ceil(taken / pack);
      chatReplies = Array.from({ length: packs }, () => annotateReply);
      const before = snapshot();
      const res = await annotate();
      const used = since(before);
      delete process.env.ANNOTATE_PACK;
      measured[`annotate request, ${pending} pending, ${pack} per call`] = { ...used, estimate: ANNOTATE_FIXED_SUBREQUESTS + packs * ANNOTATE_PACK_SUBREQUESTS };
      expect(await res.json()).toEqual({ annotated: taken, missing: 0, calls: packs, remaining: pending - taken });
      // Ten packs at most, whatever the pack size: 200 items at 20, 100 at 10.
      expect(batch).toBe(10 * pack);
      expect(used).toEqual({ fetch: packs, sql: 6 + 2 * packs, metering: packs });
      // The estimate counts what the code did plus the session, the users row and the ceiling read,
      // and stays under the 40 the tool loop keeps to.
      expect(ANNOTATE_FIXED_SUBREQUESTS + packs * ANNOTATE_PACK_SUBREQUESTS).toBe(used.fetch + used.sql + 4);
      expect(used.fetch + used.sql + 4).toBeLessThanOrEqual(40);
    });
  }
});

// POST /api/assist/suggest {mode: briefing} after the session (requireAuthed is mocked, so the
// session and the users row are not counted here: +3, as BRIEFING_PRELUDE_SUBREQUESTS counts them
// with the timezone update and the charge). Five candidate reads, the rank run, the write context,
// the write step's loop (its run row, one or two model calls and any lookups) and one insert.
describe("one briefing", () => {
  const suggest = () =>
    assistPOST(new Request("http://x/api/assist/suggest", { method: "POST", body: JSON.stringify({ tz: "UTC", mode: "briefing" }) }), {
      params: Promise.resolve({ action: "suggest" }),
    });
  // The ranker: every candidate worth it.
  const rankReply = (body: Json) => {
    const about: string[] = body.response_format.json_schema.schema.properties.answers.items.properties.about.enum.filter((a: unknown) => a !== null);
    return { content: JSON.stringify({ answers: about.map((n) => ({ about: n, worth: 0.9, urgency: 0.5, repeat: 0 })) }) };
  };
  // The writer: one draft citing the first ref it was sent.
  const writeReply = (body: Json) => {
    const ref = /\\?"ref\\?":\\?"(i\d+)/.exec(body.messages[0].content)![1];
    return {
      content: JSON.stringify({
        suggestions: [{ candidate: "c1", kind: "draft", title: `Reply to Priya ${ref}`, detail: "d", draft_text: "Hi", evidence: [{ ref, quote: "q" }], urgency: "high", confidence: 0.9 }],
      }),
    };
  };

  async function setup() {
    const u = await createUser(count.t.sql);
    await seedArchive(u, 40);
    await count.t.sql`update context_items set triage = 'key', salience = 0.6, needs_reply = 0.9, signals = '{}'::jsonb, signals_at = now() where user_id = ${u}`;
    await refreshOpenLoops(u);
    auth.user = { id: u, tz: "UTC", plan: "pro", unlimited: false };
    return u;
  }

  async function measure(label: string, replies: ((body: Json) => Json)[]) {
    const u = await setup();
    chatReplies = replies;
    const before = snapshot();
    const res = await suggest();
    const used = since(before);
    expect((await res.json()).suggestions).toHaveLength(1);
    const [run] = await count.t.sql`select output from agent_runs where user_id = ${u} and task = 'briefing'`;
    measured[`briefing: ${label}`] = { ...used, estimate: run.output.subrequests + BRIEFING_INSERT_SUBREQUESTS };
    // The loop's estimate starts from what the request spent before it, session and ceiling read
    // included, so it never undercounts what the code did.
    expect(run.output.subrequests + BRIEFING_INSERT_SUBREQUESTS).toBeGreaterThanOrEqual(used.fetch + used.sql + 3);
    expect(used.fetch + used.sql + 3).toBeLessThanOrEqual(40);
    return { used, output: run.output };
  }

  it("declares what comes before the write step", () => {
    expect(BRIEFING_PRELUDE_SUBREQUESTS + BRIEFING_READ_SUBREQUESTS + RANK_SUBREQUESTS + WRITE_CONTEXT_SUBREQUESTS).toBe(17);
  });

  it("rank, then the write step answering at once", async () => {
    const { used } = await measure("rank + write, no lookup", [rankReply, writeReply]);
    expect(used.fetch).toBe(2);
  });

  it("rank, then a write step that looks up three things before it answers", async () => {
    const { used, output } = await measure("rank + write after recall, person and entity", [
      rankReply,
      toolCalls(["recall", { query: "Atlas pricing", container: null }], ["person", { who: "Priya" }], ["entity", { name: "Priya Nair", kind: null }]),
      writeReply,
    ]);
    expect(output.stopped).toBe("max_steps");
    // Only the lookups that fit ran; the rest answered `budget`.
    expect(used.fetch).toBeGreaterThanOrEqual(3);
  });
});

// GET /api/assist/catchup: the open-loop refresh is one call before the plan's reads.
describe("one catch-up plan read", () => {
  it("refreshes open loops with one call", async () => {
    const u = await createUser(count.t.sql);
    await seedArchive(u, 40);
    await count.t.sql`update context_items set triage = 'key', salience = 0.6, needs_reply = 0.9, signals = '{}'::jsonb, signals_at = now() where user_id = ${u}`;
    auth.user = { id: u, tz: "UTC", plan: "pro", unlimited: false };
    const before = snapshot();
    const res = await assistPOST(new Request("http://x/api/assist/catchup"), { params: Promise.resolve({ action: "catchup" }) });
    const used = since(before);
    measured["catch-up plan read, with the loop refresh"] = used;
    expect((await res.json()).loops).toMatchObject({ opened: 5 });
    expect(used.fetch).toBe(0);
  });
});
