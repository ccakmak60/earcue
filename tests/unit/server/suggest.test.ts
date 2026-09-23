import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, fakeEmbedding, migratedDb, type TestDb } from "./_pglite";

// Briefing-mode suggestions and the multi-day read against the migrated schema. Only Azure is faked:
// chatJson records the prompt it was sent and answers with the queued suggestions.
const state = vi.hoisted(() => ({
  t: null as unknown as TestDb,
  user: null as { id: string; tz: string; plan: string } | null,
  prompts: [] as string[],
  reply: [] as unknown[],
}));

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
vi.mock("@/lib/server/llm", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/llm")>()),
  chatJson: vi.fn(async ({ messages }: { messages: { content: string }[] }) => {
    state.prompts.push(messages[0].content);
    return { suggestions: state.reply };
  }),
}));
vi.mock("@/lib/server/auth", () => ({
  requireAuthed: vi.fn(async () => state.user),
  touchTz: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/quota", () => ({ consume: vi.fn(async () => {}), localDay: () => "2026-09-22" }));

import { handleSuggest, handleSuggestionsGet } from "@/lib/server/assist/suggest";

async function seed(day: string, title: string, status = "shown") {
  await state.t.sql`
    insert into suggestions (user_id, client_id, local_day, kind, title, detail, urgency, status, dedup_key)
    values (${state.user!.id}, ${`c-${title}`}, ${day}, 'idea', ${title}, '', 'low', ${status}, ${`k-${title}`})
  `;
}

async function seedEvent(title: string, userId = state.user!.id): Promise<number> {
  const [row] = await state.t.sql`
    insert into context_items (user_id, provider, external_id, ts, kind, title)
    values (${userId}, 'google', ${`cal:${title}`}, now() + interval '2 hours', 'event', ${title})
    returning id
  `;
  return Number(row.id);
}

function payloadOf(prompt: string): Record<string, unknown> {
  return JSON.parse(prompt.slice(prompt.indexOf("\n\n{") + 2));
}

beforeAll(async () => {
  state.t = await migratedDb();
});

beforeEach(async () => {
  state.user = { id: await createUser(state.t.sql), tz: "UTC", plan: "pro" };
  state.prompts = [];
  state.reply = [];
});

describe("GET suggestions", () => {
  it("reads one day by default and a trailing window with days", async () => {
    await seed("2026-09-22", "today");
    await seed("2026-09-18", "this week");
    await seed("2026-09-10", "too old");
    const get = async (qs: string) =>
      (await (await handleSuggestionsGet(new Request(`http://x/api/assist/suggestions?${qs}`))).json()).suggestions.map((s: { title: string }) => s.title);

    expect(await get("day=2026-09-22")).toEqual(["today"]);
    expect((await get("day=2026-09-22&days=7")).sort()).toEqual(["this week", "today"]);
  });

  it("rejects a malformed day", async () => {
    expect((await handleSuggestionsGet(new Request("http://x/api/assist/suggestions?day=today"))).status).toBe(400);
  });
});

describe("POST suggest in briefing mode", () => {
  it("uses the archive-only instruction and passes this week's titles and a month of dismissals", async () => {
    await seed("2026-09-21", "Reply to Maya");
    await seed("2026-09-05", "Old idea");
    await seed("2026-09-01", "Stop suggesting gym", "dismissed");
    await seed("2026-07-01", "Ancient dismissal", "dismissed");
    const event = await seedEvent("Venue walkthrough");
    state.reply = [{ kind: "draft", title: "Confirm the venue", detail: "d", draft_text: "Hi", evidence: [{ ref: `i${event}`, quote: "Venue?" }], urgency: "high", confidence: 0.9 }];

    const res = await handleSuggest(new Request("http://x", { method: "POST", body: JSON.stringify({ tz: "UTC", mode: "briefing" }) }));
    const body = await res.json();

    expect(body.suggestions).toMatchObject([{ kind: "draft", title: "Confirm the venue", draftText: "Hi", evidence: ["Venue?"] }]);
    expect(state.prompts[0]).toContain("There is no live activity");
    const payload = payloadOf(state.prompts[0]);
    expect(payload.already).toEqual(expect.arrayContaining(["Reply to Maya", "Stop suggesting gym"]));
    expect(payload.already).not.toContain("Old idea");
    expect(payload.not_useful).toEqual(["Stop suggesting gym"]);
    expect(payload.calendar).toEqual([expect.objectContaining({ ref: `i${event}`, title: "Venue walkthrough" })]);
    expect((payload.calendar as object[])[0]).not.toHaveProperty("id");
  });

  it("keeps only evidence the run sent, drops a suggestion with none, and logs the run", async () => {
    const event = await seedEvent("Board meeting");
    const foreign = await seedEvent("Someone else's event", await createUser(state.t.sql));
    state.reply = [
      { kind: "reminder", title: "Prepare the board deck", detail: "d", evidence: [{ ref: `i${event}`, quote: "Board" }, { ref: "i999999", quote: "made up" }], urgency: "high", confidence: 0.8 },
      { kind: "idea", title: "Cites another account", detail: "d", evidence: [{ ref: `i${foreign}`, quote: "x" }], urgency: "low", confidence: 0.5 },
      { kind: "idea", title: "Cites nothing", detail: "d", evidence: [], urgency: "low", confidence: 0.5 },
    ];

    const body = await (await handleSuggest(new Request("http://x", { method: "POST", body: JSON.stringify({ tz: "UTC", mode: "briefing" }) }))).json();
    expect(body.suggestions.map((s: { title: string }) => s.title)).toEqual(["Prepare the board deck"]);

    const [run] = await state.t.sql`select * from agent_runs where user_id = ${state.user!.id}`;
    expect(run).toMatchObject({ task: "briefing", prompt_version: "1", outcome: "ok", error: null });
    expect(run.input_refs.items).toEqual([event]);
    expect(run.output).toMatchObject({ dropped: 2, bad_refs: 2, duplicates: 0 });
    const [stored] = await state.t.sql`select id, evidence, run_id from suggestions where user_id = ${state.user!.id}`;
    expect(stored.run_id).toBe(run.id);
    expect(stored.evidence).toEqual([{ ref: `i${event}`, quote: "Board" }]);
    expect(run.output.suggestions).toEqual([Number(stored.id)]);
  });

  it("records invalid when every suggestion is dropped and empty when none were made", async () => {
    state.reply = [{ kind: "idea", title: "Unsupported", detail: "d", evidence: [{ ref: "m1", quote: "x" }], urgency: "low", confidence: 0.5 }];
    await handleSuggest(new Request("http://x", { method: "POST", body: JSON.stringify({ tz: "UTC", mode: "briefing" }) }));
    state.reply = [];
    await handleSuggest(new Request("http://x", { method: "POST", body: JSON.stringify({ tz: "UTC", mode: "briefing" }) }));

    const runs = await state.t.sql`select outcome from agent_runs where user_id = ${state.user!.id} order by started_at, id`;
    expect(runs.map((r) => r.outcome).sort()).toEqual(["empty", "invalid"]);
  });

  it("returns nothing in live mode without recent activity, without calling the model or logging a run", async () => {
    const res = await handleSuggest(new Request("http://x", { method: "POST", body: JSON.stringify({ tz: "UTC", mode: "live" }) }));
    expect((await res.json()).suggestions).toEqual([]);
    expect(state.prompts).toHaveLength(0);
    expect(await state.t.sql`select 1 from agent_runs where user_id = ${state.user!.id}`).toEqual([]);
  });
});
