import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, fakeEmbedding, migratedDb, type TestDb } from "../_pglite";

// Decision H3: how many subrequests one loop run and one distill pass make, against Workers Free's
// 50 per request. Nothing here runs in workerd, so this counts the calls the code makes: every
// fetch (model calls and embeddings, each a subrequest by Cloudflare's definition) and every `sql`
// call (each opens its own Hyperdrive connection in production; whether those count against the
// 50 is not documented, so both totals are reported). The model, the embeddings and llm_usage_daily
// metering are the real code paths; only fetch is stubbed and Postgres is PGlite.
const count = vi.hoisted(() => ({ fetch: 0, sql: 0, metering: 0, t: null as unknown as TestDb }));
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
import { insertContextItems, runDistillPass } from "@/lib/server/knowledge";

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
    const ctx: ToolContext = { userId: user, seen, userAsked: false, refs: { item: (id) => seen.item(id), memory: (id) => seen.memory(id) } };
    const [first] = await count.t.sql`select id from context_items where user_id = ${user} order by id limit 1`;
    seen.item(first.id);
    const args: Record<string, Json> = {
      recall: { query: "Atlas pricing" },
      search_items: { query: "board deck" },
      thread: { ref: `i${first.id}` },
      calendar: { from: new Date().toISOString() },
      person: { who: "Priya" },
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

  for (const n of [5, 10, 25]) {
    it(`with ${n} new memories`, async () => {
      const u = await createUser(count.t.sql);
      await seedArchive(u, 40);
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
      expect(result).toMatchObject({ processed: 40, created: n });
    });
  }
});
