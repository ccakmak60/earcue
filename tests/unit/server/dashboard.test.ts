import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { contextParts } from "./_context";
import { createUser, fakeEmbedding, migratedDb, type TestDb } from "./_pglite";

// The Dashboard view's build (candidates, fingerprint, decide, layout), its live read and pin/hide,
// against the migrated schema. Only Azure is faked: chatJson is the decide() call and answers from
// `answer`, recording what it was sent.
type Json = Record<string, any>;
const state = vi.hoisted(() => ({
  t: null as unknown as TestDb,
  user: null as { id: string; tz: string; plan: string } | null,
  prompts: [] as string[],
  answer: null as ((prompt: string) => Json[]) | null,
  fails: false,
  charged: 0,
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
    if (state.fails) throw new Error("llm 503: unavailable");
    return { answers: state.answer!(messages[0].content) };
  }),
}));
vi.mock("@/lib/server/auth", () => ({
  requireAuthed: vi.fn(async () => state.user),
  touchTz: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/quota", () => ({
  consume: vi.fn(async () => {
    state.charged++;
  }),
  localDay: () => "2026-09-25",
}));

import { handleDashboard, handleDashboardBuild, handleDashboardPanel } from "@/lib/server/assist/dashboard";
import { insertContextItems, upsertMemories } from "@/lib/server/knowledge";
import { linkMemoryEntities } from "@/lib/server/entities";
import { refreshOpenLoops } from "@/lib/server/open-loops";

const HOUR = 3600_000;
const ME = "Alex <alex@example.com>";
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const mail = (id: string, hoursAgo: number, from: string, subject: string, body: string, thread: string, to = ME) => ({
  externalId: `gm:${id}`,
  ts: ago(hoursAgo),
  kind: "email",
  title: subject,
  body,
  url: null,
  meta: { from, to, threadId: thread, sent: from === ME },
});

async function itemId(externalId: string): Promise<number> {
  const [row] = await state.t.sql`select id from context_items where user_id = ${state.user!.id} and external_id = ${externalId}`;
  return Number(row.id);
}

async function entityId(name: string): Promise<string> {
  const [row] = await state.t.sql`select id from entities where user_id = ${state.user!.id} and name = ${name}`;
  return String(row.id);
}

// Every item annotated and not sensitive, unless the pattern says otherwise.
async function annotateAll(overrides: Record<string, Json> = {}) {
  await state.t.sql`
    update context_items set triage = 'keep', salience = 0.6, needs_reply = 0, commitment = 0,
           signals = '{"sensitive": 0.05}'::jsonb, signals_at = now()
    where user_id = ${state.user!.id}
  `;
  for (const [externalId, s] of Object.entries(overrides)) {
    await state.t.sql`
      update context_items set triage = ${s.triage ?? "keep"}, needs_reply = ${s.needs_reply ?? 0}, commitment = ${s.commitment ?? 0},
             signals = ${JSON.stringify({ sensitive: s.sensitive ?? 0.05 })}::jsonb
      where user_id = ${state.user!.id} and external_id = ${externalId}
    `;
  }
}

// Priya at Acme writes most (six mails, the last one owed a reply); Alex promised Tom a deck; the
// clinic wrote five times, all of it sensitive; a board prep with Tom in two days; Atlas is a project
// with a memory, and there is a parked podcast idea.
async function seedArchive() {
  const u = state.user!.id;
  await state.t.sql`insert into connections (user_id, provider, account_label, access_token_enc) values (${u}, 'google', 'alex@example.com', 'x')`;
  await state.t.sql`select ensure_self_entity(${u}::uuid)`;
  await insertContextItems(u, "google", null, [
    ...Array.from({ length: 5 }, (_, i) =>
      mail(`p${i}`, 200 + i * 24, "Priya Nair <priya@acme.example>", `Atlas pricing ${i}`, `Notes on the tiers, part ${i}. Confidential rollout detail.`, `th-p${i}`)
    ),
    mail("ask", 26, "Priya Nair <priya@acme.example>", "Pricing tiers", "Could you send the final pricing tiers by Thursday?", "th-ask"),
    mail("promise", 50, ME, "Deck", "I'll send you the board deck on Friday.", "th-d", "Tom Keller <tom@acme.example>"),
    ...Array.from({ length: 5 }, (_, i) =>
      mail(`c${i}`, 30 + i * 24, "Clinic <agenda@clinic.example>", `Test results ${i}`, "Your results are ready.", `th-c${i}`)
    ),
    ...Array.from({ length: 8 }, (_, i) => mail(`n${i}`, 10 + i * 24, "Digest <news@digest.example>", `Digest ${i}`, "This week in pricing.", `th-n${i}`)),
    { externalId: "cal:1", ts: new Date(Date.now() + 48 * HOUR).toISOString(), kind: "event", title: "Board prep", body: "Prep", url: null, meta: { attendees: ["Tom Keller <tom@acme.example>"] } },
  ]);
  await annotateAll({
    "gm:ask": { needs_reply: 0.9, triage: "key" },
    "gm:promise": { commitment: 0.9 },
    ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`gm:c${i}`, { sensitive: 0.9, triage: "key" }])),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`gm:n${i}`, { triage: "drop" }])),
  });
  const { idByIndex } = await upsertMemories(
    u,
    [
      { kind: "project", subject: "Atlas", text: "Atlas is the pricing relaunch Alex leads.", importance: 0.8, confidence: 0.9, source_ids: [await itemId("gm:p0")] },
      { kind: "person", subject: "Priya Nair", text: "Priya Nair runs pricing at Acme.", importance: 0.8, confidence: 0.9, source_ids: [await itemId("gm:p1")] },
      { kind: "person", subject: "Priya Nair", text: "Priya Nair is on medical leave in October.", importance: 0.8, confidence: 0.9, source_ids: [await itemId("gm:p2")], sensitive: true },
      { kind: "project", subject: "Podcast", text: "Alex wants to start a podcast about pricing.", importance: 0.5, confidence: 0.8, source_ids: [] },
    ],
    "import"
  );
  await linkMemoryEntities(u, [
    { memoryId: idByIndex[0], kind: "project", name: "Atlas" },
    { memoryId: idByIndex[1], kind: "person", name: "Priya Nair" },
    { memoryId: idByIndex[2], kind: "person", name: "Priya Nair" },
    { memoryId: idByIndex[3], kind: "idea", name: "Podcast" },
  ]);
  await state.t.sql`update entities set status = 'parked' where user_id = ${u} and name = 'Podcast'`;
  await refreshOpenLoops(u);
}

const build = async () => (await handleDashboardBuild(new Request("http://x", { method: "POST", body: "{}" }))).json();
const read = async () => (await handleDashboard(new Request("http://x/api/assist/dashboard"))).json();
const panel = (body: Json) => handleDashboardPanel(new Request("http://x", { method: "POST", body: JSON.stringify(body) }));

const panelsIn = (prompt: string) => contextParts(prompt).untrusted.panels as Json[];

// Every panel useful, by name or panel text overrides.
function scoreAll(prompt: string, overrides: (p: Json) => Json | undefined = () => undefined): Json[] {
  return panelsIn(prompt).map((p) => ({ about: p.w, useful: 0.9, central: 0.5, ...overrides(p) }));
}

async function runsOf() {
  return state.t.sql`select task, prompt_version, model, outcome, error, output from agent_runs where user_id = ${state.user!.id} order by started_at, id`;
}

beforeAll(async () => {
  state.t = await migratedDb();
});

beforeEach(async () => {
  state.user = { id: await createUser(state.t.sql), tz: "UTC", plan: "pro" };
  state.prompts = [];
  state.answer = (prompt) => scoreAll(prompt);
  state.fails = false;
  state.charged = 0;
});

describe("POST dashboard-build", () => {
  it("offers the panels with data behind them, counts and names only, and stores what the model chose", async () => {
    await seedArchive();
    const priya = await entityId("Priya Nair");
    const clinic = await entityId("Clinic");
    const atlas = await entityId("Atlas");
    state.answer = (prompt) =>
      scoreAll(prompt, (p) => (p.name === "Clinic" ? { useful: 0.1 } : p.panel.startsWith("All their projects") ? { useful: 0.6, central: 1 } : undefined));

    const body = await build();

    // Candidates in the fallback order: replies owed (Priya), the board prep, the promise to Tom,
    // cards for Priya (six mails) and the clinic (five) and the Atlas project, then the projects list
    // (Atlas and the podcast). Tom has two items, too few for a card; the digest sent eight, all of
    // them noise, so it is no busy contact either; there are no recommendations.
    const sent = contextParts(state.prompts[0]);
    const panels = sent.untrusted.panels as Json[];
    expect(panels.map((p) => [p.w, p.name ?? p.panel.split(":")[0].split(",")[0]])).toEqual([
      ["w1", "Messages waiting for the person's reply"],
      ["w2", "Their meetings and events in the next 7 days"],
      ["w3", "Things the person promised someone and has not done yet"],
      ["w4", "Priya Nair"],
      ["w5", "Clinic"],
      ["w6", "Atlas"],
      ["w7", "All their projects and ideas in one list"],
    ]);
    expect(panels.find((p) => p.name === "Priya Nair")).toMatchObject({ kind: "person", items_90_days: 6, open_loops: 1, memories: 1 });
    expect(panels[0]).toMatchObject({ open: 1, people: 1 });
    // No item text reaches the model, sensitive or not.
    expect(state.prompts[0]).not.toContain("Confidential rollout");
    expect(state.prompts[0]).not.toContain("Could you send");
    expect(state.prompts[0]).not.toContain("medical leave");
    expect(sent.trusted).toMatchObject({ about: ["w1", "w2", "w3", "w4", "w5", "w6", "w7"], today: expect.any(String), profile_static: [] });

    // Clinic scored not useful; projects scored most central.
    expect(body).toEqual({ built: true, panels: ["projects", "replies_owed", "upcoming", "promises", `entity:${priya}`, `entity:${atlas}`] });
    expect(body.panels).not.toContain(`entity:${clinic}`);
    expect(state.charged).toBe(1);

    const [run] = await runsOf();
    expect(run).toMatchObject({ task: "dashboard", prompt_version: "2", outcome: "ok", error: null });
    expect(run.output).toMatchObject({ candidates: 7, asked: 7, answered: 7, useful: 6, chosen: body.panels, filled: 0 });
    const [row] = await state.t.sql`select spec, fingerprint, run_id, built_at from dashboards where user_id = ${state.user!.id}`;
    expect(row.spec).toEqual({ panels: body.panels, by: "decide", filled: 0 });
    expect(row.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(row.run_id).not.toBeNull();
  });

  it("does nothing, and charges nothing, while the candidates are unchanged and the page is under a day old", async () => {
    await seedArchive();
    const first = await build();
    const again = await build();
    expect(again).toEqual({ built: false, panels: first.panels });
    expect(state.prompts).toHaveLength(1);
    expect(state.charged).toBe(1);

    // A second owed reply stays in the band (one or two): nothing to do.
    const owe = async (id: string) => {
      await insertContextItems(state.user!.id, "google", null, [mail(id, 3, "Priya Nair <priya@acme.example>", `Contract ${id}`, "Can you sign by Monday?", `th-${id}`)]);
      await state.t.sql`update context_items set needs_reply = 0.9, signals = '{"sensitive": 0.05}'::jsonb, signals_at = now() where external_id = ${`gm:${id}`}`;
      await refreshOpenLoops(state.user!.id);
    };
    await owe("ask2");
    expect((await build()).built).toBe(false);
    // A third is a new band: rebuilt.
    await owe("ask3");
    expect((await build()).built).toBe(true);
    expect(state.prompts).toHaveLength(2);

    // A day old: rebuilt even with nothing new.
    await state.t.sql`update dashboards set built_at = now() - interval '25 hours' where user_id = ${state.user!.id}`;
    expect((await build()).built).toBe(true);
    expect(state.charged).toBe(3);
  });

  it("keeps the fixed order when the call fails", async () => {
    await seedArchive();
    state.fails = true;
    const body = await build();
    const clinic = await entityId("Clinic");
    const priya = await entityId("Priya Nair");
    expect(body.panels).toEqual(["replies_owed", "upcoming", "promises", `entity:${priya}`, `entity:${clinic}`, "projects"]);
    const [row] = await state.t.sql`select spec from dashboards where user_id = ${state.user!.id}`;
    expect(row.spec.by).toBe("fallback");
    const [run] = await runsOf();
    expect(run).toMatchObject({ task: "dashboard", outcome: "error", error: "llm_503" });
  });

  it("fills to three when the model finds too little useful", async () => {
    await seedArchive();
    state.answer = (prompt) => scoreAll(prompt, () => ({ useful: 0.2 }));
    expect((await build()).panels).toEqual(["replies_owed", "upcoming", "promises"]);
    const [row] = await state.t.sql`select spec from dashboards where user_id = ${state.user!.id}`;
    expect(row.spec).toMatchObject({ by: "decide", filled: 3 });
  });

  it("builds an empty page for an account with nothing yet, without a model call", async () => {
    expect(await build()).toEqual({ built: true, panels: [] });
    expect(state.prompts).toHaveLength(0);
    expect(state.charged).toBe(0);
  });
});

describe("GET dashboard", () => {
  it("reads each chosen panel now, under the proactive rule", async () => {
    await seedArchive();
    const clinic = await entityId("Clinic");
    const priya = await entityId("Priya Nair");
    await build();
    await state.t.sql`
      update dashboards set spec = ${JSON.stringify({ panels: ["replies_owed", "upcoming", `entity:${priya}`, `entity:${clinic}`, "projects", "topics", "inbox_pulse", "recommendations"], by: "decide", filled: 0 })}::jsonb
      where user_id = ${state.user!.id}
    `;

    const body = await read();
    expect(body.by).toBe("decide");
    const byKey = Object.fromEntries(body.panels.map((p: Json) => [p.key, p]));
    expect(byKey.replies_owed.entries).toEqual([expect.objectContaining({ who: "Priya Nair", title: "Pricing tiers", provider: "google" })]);
    expect(byKey.upcoming.entries).toEqual([expect.objectContaining({ title: "Board prep", people: [{ name: "Tom Keller", lastContact: expect.any(String) }] })]);

    // Priya's card: her mails, her non-sensitive memory only, the owed reply.
    const card = byKey[`entity:${priya}`].card;
    expect(card).toMatchObject({ name: "Priya Nair", kind: "person", items90d: 6, memories: ["Priya Nair runs pricing at Acme."] });
    expect(card.loops).toEqual([expect.objectContaining({ kind: "reply_owed", title: "Pricing tiers" })]);
    expect(card.latest.map((i: Json) => i.title)).toEqual(["Pricing tiers", "Atlas pricing 0", "Atlas pricing 1"]);

    // The clinic's items are all sensitive: its card lists none of them.
    expect(byKey[`entity:${clinic}`].card).toMatchObject({ name: "Clinic", items90d: 5, latest: [], loops: [] });

    expect(byKey.projects.entries.map((p: Json) => [p.name, p.status])).toEqual([
      ["Atlas", "active"],
      ["Podcast", "parked"],
    ]);
    expect(byKey.inbox_pulse.entries).toEqual([expect.objectContaining({ provider: "google", owed: 1 })]);
    expect(byKey.recommendations.entries).toEqual([]);
  });

  it("drops a card whose entity is gone, and answers an empty page before any build", async () => {
    expect(await read()).toEqual({ panels: [], builtAt: null, by: null, hidden: [] });
    await seedArchive();
    await state.t.sql`
      insert into dashboards (user_id, spec) values (${state.user!.id}, ${JSON.stringify({ panels: ["entity:999999", "replies_owed"] })}::jsonb)
    `;
    expect((await read()).panels.map((p: Json) => p.key)).toEqual(["replies_owed"]);
  });
});

describe("POST dashboard-panel", () => {
  it("hides a panel at once and keeps it out of the next build", async () => {
    await seedArchive();
    await build();
    const res = await panel({ key: "upcoming", action: "hide" });
    expect(await res.json()).toMatchObject({ hidden: ["upcoming"] });
    expect((await read()).hidden).toEqual(["upcoming"]);
    expect((await read()).panels.map((p: Json) => p.key)).not.toContain("upcoming");

    await state.t.sql`update dashboards set built_at = now() - interval '2 days' where user_id = ${state.user!.id}`;
    await build();
    expect(panelsIn(state.prompts[1]).some((p) => p.panel.includes("meetings and events"))).toBe(false);
    expect(panelsIn(state.prompts[1]).length).toBeGreaterThan(0);
  });

  it("pins a card to the top, keeps it whatever the model says, and does not ask about it", async () => {
    await seedArchive();
    const clinic = await entityId("Clinic");
    await build();
    await panel({ key: `entity:${clinic}`, action: "pin" });
    expect((await read()).panels[0]).toMatchObject({ key: `entity:${clinic}`, pinned: true });

    await state.t.sql`update dashboards set built_at = now() - interval '2 days' where user_id = ${state.user!.id}`;
    state.answer = (prompt) => scoreAll(prompt, () => ({ useful: 0 }));
    const body = await build();
    expect(body.panels[0]).toBe(`entity:${clinic}`);
    expect(panelsIn(state.prompts[1]).map((p) => p.name)).not.toContain("Clinic");
  });

  it("refuses a key outside the catalog", async () => {
    expect((await panel({ key: "<img>", action: "pin" })).status).toBe(400);
    expect((await panel({ key: "topics", action: "delete" })).status).toBe(400);
  });
});
