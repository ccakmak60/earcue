import { beforeAll, describe, expect, it, vi } from "vitest";
import { gmailItem, type GmailMessage } from "@/lib/shared/gmail";
import { createUser, fakeEmbedding, migratedDb, type TestDb } from "./_pglite";

// The knowledge pipeline end to end against real Postgres + pgvector, migrated from db/migrations:
// ingest → embed → distill → recall → delete. Only Azure is faked — embeddings are a deterministic
// bag-of-words hash (shared words ⇒ high cosine) and chatJson returns the queued distillation.
const state = vi.hoisted(() => ({
  t: null as unknown as TestDb,
  distill: [] as unknown[],
  derived: [] as unknown[],
  prompts: [] as string[],
  user: null as { id: string; tz: string } | null,
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
  chatJson: vi.fn(async ({ schema, messages }: { schema: { required: string[] }; messages: { content: string }[] }) => {
    state.prompts.push(messages[0].content);
    if (schema.required.includes("memories")) return { memories: state.distill };
    if (schema.required.includes("summary")) return { summary: "", static_facts: [], dynamic_facts: [], buckets: {} };
    if (schema.required.includes("derived")) return { derived: state.derived };
    return {};
  }),
}));
vi.mock("@/lib/server/auth", () => ({
  requireAuthed: vi.fn(async () => state.user),
}));
vi.mock("@/lib/server/quota", () => ({ consume: vi.fn(async () => {}), localDay: () => "2026-09-22" }));

import { handleCatchup } from "@/lib/server/assist/catchup";
import {
  embedPendingItems,
  insertContextItems,
  peopleSummary,
  purgeHost,
  recall,
  removeImport,
  runConsolidationPass,
  runDistillPass,
  upsertMemories,
} from "@/lib/server/knowledge";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function gmail(id: string, over: Partial<{ from: string; to: string; subject: string; text: string; labels: string[] }> = {}): GmailMessage {
  return {
    id,
    threadId: `t-${id}`,
    internalDate: String(Date.parse("2026-09-20T09:00:00Z")),
    labelIds: over.labels ?? ["INBOX"],
    snippet: "snippet only",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Subject", value: over.subject ?? "Lisbon offsite" },
        { name: "From", value: over.from ?? "Jane Doe <Jane@Acme.com>" },
        { name: "To", value: over.to ?? "me@example.com, Bob <bob@acme.com>" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64(over.text ?? "Booked the Lisbon hotel near Alfama for the offsite.") } },
        { mimeType: "text/html", body: { data: b64("<p>ignored</p>") } },
      ],
    },
  };
}

async function newImport(userId: string, source = "doc"): Promise<number> {
  const [row] = await state.t.sql`insert into imports (user_id, source) values (${userId}, ${source}) returning id`;
  return Number(row.id);
}

async function itemId(userId: string, externalId: string): Promise<number> {
  const [row] = await state.t.sql`select id from context_items where user_id = ${userId} and external_id = ${externalId}`;
  return Number(row.id);
}

const mem = (over: Record<string, unknown>) => ({
  kind: "fact",
  subject: "s",
  text: "t",
  container: "self",
  importance: 0.6,
  confidence: 0.8,
  evidence: [],
  ...over,
});

describe("knowledge pipeline on real Postgres", () => {
  beforeAll(async () => {
    state.t = await migratedDb();
  }, 60000);

  it("stores a Gmail message as full text with normalised participants", async () => {
    const user = await createUser(state.t.sql);
    const item = gmailItem(gmail("m1"))!;
    await insertContextItems(user, "google", null, [item]);

    const [row] = await state.t.sql`select body, participants, embedding from context_items where user_id = ${user}`;
    expect(row.body).toBe("Booked the Lisbon hotel near Alfama for the offsite.");
    expect([...row.participants].sort()).toEqual(["bob@acme.com", "jane@acme.com", "me@example.com"]);
    expect(row.embedding).toBeNull();
  });

  it("drops a stored vector when the item's text changes, and keeps it when it does not", async () => {
    const user = await createUser(state.t.sql);
    const item = gmailItem(gmail("m2"))!;
    await insertContextItems(user, "google", null, [item]);
    expect(await embedPendingItems(user, 10)).toBe(1);

    await insertContextItems(user, "google", null, [item]);
    let [row] = await state.t.sql`select embedding is not null as has from context_items where user_id = ${user}`;
    expect(row.has).toBe(true);

    await insertContextItems(user, "google", null, [{ ...item, body: "Hotel cancelled." }]);
    [row] = await state.t.sql`select embedding is not null as has from context_items where user_id = ${user}`;
    expect(row.has).toBe(false);
  });

  it("moves a rescheduled calendar event earlier instead of keeping the later start", async () => {
    const user = await createUser(state.t.sql);
    const event = { externalId: "cal:1", ts: "2026-09-22T15:00:00.000Z", kind: "event", title: "Sync", body: "", url: null, meta: { attendees: ["a@x.io"] } };
    await insertContextItems(user, "google", null, [event]);
    await insertContextItems(user, "google", null, [{ ...event, ts: "2026-09-22T13:00:00.000Z" }]);
    const [row] = await state.t.sql`select ts, participants from context_items where user_id = ${user}`;
    expect(new Date(row.ts).toISOString()).toBe("2026-09-22T13:00:00.000Z");
    expect(row.participants).toEqual(["a@x.io"]);
  });

  it("distills with item refs, sender direction and people, then links only in-batch sources", async () => {
    const user = await createUser(state.t.sql);
    const [au] = await state.t.sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ('au-1', 'Me', 'me@example.com', true, now(), now()) returning id`;
    await state.t.sql`update users set auth_user_id = ${au.id} where id = ${user}`;
    await insertContextItems(user, "google", null, [
      gmailItem(gmail("d1"))!,
      gmailItem(gmail("d2", { from: "Me <me@example.com>", to: "Jane Doe <jane@acme.com>", subject: "Re: seats", text: "Please book me an aisle seat, I always prefer the aisle.", labels: ["SENT"] }))!,
    ]);
    const d1 = await itemId(user, "gm:d1");
    const d2 = await itemId(user, "gm:d2");

    state.prompts = [];
    state.distill = [
      mem({ kind: "preference", subject: "Flights", text: "Prefers aisle seats on flights.", source_refs: [`i${d2}`, "i999999"] }),
      mem({ kind: "fact", subject: "Health", text: "Has a knee injury and avoids long walks.", sensitive: true, source_refs: [`i${d1}`, `m${d1}`] }),
    ];
    const result = await runDistillPass({ id: user, tz: "UTC" }, Date.now() + 60000);
    expect(result).toMatchObject({ processed: 2, created: 2, embedded: 2, remaining: 0 });

    const payload = JSON.parse(state.prompts[0].slice(state.prompts[0].indexOf("{")));
    expect(payload.items.map((i: { ref: string }) => i.ref)).toEqual([`i${d1}`, `i${d2}`]);
    expect(payload.items[0]).not.toHaveProperty("id");
    expect(payload.items[1]).toMatchObject({ from: "Me <me@example.com>", sent: true });
    const people = payload.people.map((p: { address: string }) => p.address);
    expect(people).toContain("jane@acme.com");
    expect(people).not.toContain("me@example.com");
    expect(payload.people.find((p: { address: string }) => p.address === "jane@acme.com").name).toBe("Jane Doe <Jane@Acme.com>");

    const links = await state.t.sql`
      select m.text, s.context_item_id from memory_sources s join memories m on m.id = s.memory_id
      where s.user_id = ${user} order by m.text
    `;
    expect(links.map((l) => [l.text, Number(l.context_item_id)])).toEqual([
      ["Has a knee injury and avoids long walks.", d1],
      ["Prefers aisle seats on flights.", d2],
    ]);
    const [sens] = await state.t.sql`select sensitive from memories where user_id = ${user} and subject = 'Health'`;
    expect(sens.sensitive).toBe(true);

    // One run for the distill call (the profile rebuild is its own run); ids only, no text.
    const runs = await state.t.sql`select task, outcome, input_refs, output from agent_runs where user_id = ${user} order by started_at`;
    const distill = runs.find((r) => r.task === "distill")!;
    expect(distill.outcome).toBe("ok");
    expect(distill.input_refs.items).toEqual([d1, d2]);
    expect(distill.output).toMatchObject({ created: 2, updated: 0, bad_refs: 2 });
    expect(distill.output.memories).toHaveLength(2);
    expect(JSON.stringify(distill)).not.toContain("aisle");
    expect(runs.map((r) => r.task)).toContain("profile");
  });

  it("drops relation targets the distill run did not send", async () => {
    const user = await createUser(state.t.sql);
    const [shown] = await upsertMemories(user, [mem({ subject: "Offsite", text: "The offsite is in Porto." })], "import").then((r) => Object.values(r.idByIndex));
    await insertContextItems(user, "upload", null, [
      { externalId: "o1", ts: new Date().toISOString(), kind: "doc", title: "Offsite", body: "Moved to Lisbon.", url: null, meta: {} },
    ]);
    state.prompts = [];
    state.distill = [
      mem({ subject: "Offsite", text: "The offsite moved to Lisbon.", source_refs: [], relations: [{ target_ref: `m${shown}`, relation: "updates" }, { target_ref: "m999999", relation: "updates" }] }),
    ];
    await runDistillPass({ id: user, tz: "UTC" }, Date.now() + 60000);

    const edges = await state.t.sql`select dst_id from memory_edges where user_id = ${user} and relation = 'updates'`;
    expect(edges.map((e) => Number(e.dst_id))).toEqual([Number(shown)]);
    const [run] = await state.t.sql`select output from agent_runs where user_id = ${user} and task = 'distill'`;
    expect(run.output.bad_refs).toBe(1);
  });

  it("consolidates only from memory refs the run sent, and needs two of them", async () => {
    const user = await createUser(state.t.sql);
    const { idByIndex } = await upsertMemories(
      user,
      Array.from({ length: 12 }, (_, i) => mem({ subject: `topic ${i}`, text: `Distinct fact number ${i} about topic ${i}.`, sensitive: i === 1 })),
      "import"
    );
    const [a, b, c] = [0, 1, 2].map((i) => idByIndex[i]);
    state.derived = [
      mem({ subject: "joined", text: "Topics zero and one are linked.", from_refs: [`m${a}`, `m${b}`] }),
      mem({ subject: "half", text: "Only one real source.", from_refs: [`m${c}`, "m999999"] }),
      mem({ subject: "items", text: "Cites items, not memories.", from_refs: [`i${a}`, `i${b}`] }),
    ];
    const result = await runConsolidationPass(user, Date.now() + 60000);
    state.derived = [];

    expect(result).toEqual({ derived: 1, edges: 2 });
    const [joined] = await state.t.sql`select id, sensitive, origin from memories where user_id = ${user} and subject = 'joined'`;
    expect(joined).toMatchObject({ sensitive: true, origin: "derived" });
    const [run] = await state.t.sql`select outcome, input_refs, output from agent_runs where user_id = ${user} and task = 'consolidate'`;
    expect(run.outcome).toBe("ok");
    expect(run.input_refs.memories).toHaveLength(12);
    expect(run.output).toMatchObject({ memories: [Number(joined.id)], dropped: 2, edges: 2 });
  });

  it("recalls by kind, keeps sensitive memories out unless asked, and finds documents by meaning", async () => {
    const user = await createUser(state.t.sql);
    await insertContextItems(user, "google", null, [
      gmailItem(gmail("r1", { subject: "Hotel", text: "Your Lisbon hotel reservation near Alfama is confirmed." }))!,
    ]);
    const r1 = await itemId(user, "gm:r1");
    await embedPendingItems(user, 10);
    await upsertMemories(
      user,
      [
        mem({ kind: "preference", subject: "Hotels", text: "Prefers quiet hotels in old town districts.", source_ids: [r1] }),
        mem({ kind: "fact", subject: "Hotels", text: "Pays for hotels with the corporate card.", sensitive: true }),
      ],
      "import"
    );

    const proactive = await recall(user, { query: "hotels" });
    expect(proactive.memories.map((m) => m.text)).toEqual(["Prefers quiet hotels in old town districts."]);

    const asked = await recall(user, { query: "hotels", includeSensitive: true, includeSources: true });
    expect(asked.memories).toHaveLength(2);
    const pref = asked.memories.find((m) => m.kind === "preference")!;
    expect(pref.sources).toEqual([expect.objectContaining({ kind: "email", title: "Hotel" })]);

    const onlyPrefs = await recall(user, { query: "hotels", kinds: ["preference"], includeSensitive: true });
    expect(onlyPrefs.memories.every((m) => m.kind === "preference")).toBe(true);

    // "booking" is in neither the subject nor the body, so full-text search (all terms) misses;
    // only the embedding branch can surface the reservation.
    const byMeaning = await recall(user, { query: "lisbon hotel booking" });
    expect(byMeaning.documents.map((d) => d.title)).toEqual(["Hotel"]);
  });

  it("keeps vector search exact per user: no shared ANN index, full top-k among many accounts", async () => {
    // The guard is the index check. A shared HNSW index scans ~40 neighbours across all accounts
    // before the user_id filter (2 of 30 rows came back at 20 users x 500 memories), but at the
    // row counts below the planner still picks the user_id btree, so the recall half cannot see it.
    const { rows } = await state.t.db.query<{ indexname: string }>(
      "select indexname from pg_indexes where tablename in ('memories', 'context_items') and indexdef ~* 'using (hnsw|ivfflat)'"
    );
    expect(rows).toEqual([]);

    const users: string[] = [];
    for (let u = 0; u < 20; u++) users.push(await createUser(state.t.sql));
    const ids: string[] = [];
    const texts: string[] = [];
    const lits: string[] = [];
    for (const u of users) {
      for (let i = 0; i < 40; i++) {
        const text = `memory alpha ${i} of ${u.slice(0, 8)}`;
        ids.push(u);
        texts.push(text);
        lits.push(`[${fakeEmbedding(text).join(",")}]`);
      }
    }
    await state.t.sql`
      insert into memories (user_id, kind, text, origin, embedding)
      select x.u::uuid, 'fact', x.t, 'import', x.e::vector
      from unnest(${ids}::text[], ${texts}::text[], ${lits}::text[]) as x(u, t, e)
    `;
    await state.t.db.exec("analyze memories");

    // "zebra" matches no memory, so full-text search contributes nothing: all ten come from the
    // vector branch.
    const result = await recall(users[7], { query: "alpha zebra", limit: 10 });
    expect(result.memories).toHaveLength(10);
  }, 60000);

  it("removing an import removes memories only it supported and keeps the rest", async () => {
    const user = await createUser(state.t.sql);
    const doomedImport = await newImport(user);
    const keptImport = await newImport(user);
    await insertContextItems(user, "upload", doomedImport, [
      { externalId: "a", ts: new Date().toISOString(), kind: "doc", title: "A", body: "a", url: null, meta: {} },
    ]);
    await insertContextItems(user, "upload", keptImport, [
      { externalId: "b", ts: new Date().toISOString(), kind: "doc", title: "B", body: "b", url: null, meta: {} },
    ]);
    const a = await itemId(user, "a");
    const b = await itemId(user, "b");
    await upsertMemories(
      user,
      [
        mem({ subject: "only-a", text: "Only supported by A.", source_ids: [a] }),
        mem({ subject: "both", text: "Supported by A and B.", source_ids: [a, b] }),
        mem({ subject: "manual", text: "Told to remember this." }),
      ],
      "import"
    );

    expect(await removeImport(user, doomedImport)).toEqual({ removed: true, memories: 1 });
    const left = await state.t.sql`select subject from memories where user_id = ${user} order by subject`;
    expect(left.map((r) => r.subject)).toEqual(["both", "manual"]);
    const [links] = await state.t.sql`select count(*)::int as n from memory_sources where user_id = ${user}`;
    expect(links.n).toBe(1);

    // Another user's import id removes nothing.
    const other = await createUser(state.t.sql);
    expect(await removeImport(other, keptImport)).toEqual({ removed: false, memories: 0 });
  });

  it("excluding a domain purges its pages and the memories only they supported", async () => {
    const user = await createUser(state.t.sql);
    await insertContextItems(user, "browser", null, [
      { externalId: "bh:1", ts: new Date().toISOString(), kind: "page_text", title: "Clinic", body: "appointment", url: "https://portal.clinic.example/x", meta: { host: "portal.clinic.example" } },
      { externalId: "bh:2", ts: new Date().toISOString(), kind: "page_text", title: "Docs", body: "api", url: "https://docs.example/x", meta: { host: "docs.example" } },
    ]);
    const clinic = await itemId(user, "bh:1");
    await upsertMemories(user, [mem({ subject: "clinic", text: "Sees a clinic.", source_ids: [clinic] })], "import");

    expect(await purgeHost(user, "clinic.example")).toEqual({ items: 1, memories: 1 });
    const [n] = await state.t.sql`select count(*)::int as n from context_items where user_id = ${user}`;
    expect(n.n).toBe(1);
  });

  it("summarises correspondents without the user's own connected address", async () => {
    const user = await createUser(state.t.sql);
    await state.t.sql`
      insert into connections (user_id, provider, account_label, access_token_enc)
      values (${user}, 'google', 'Me@Example.com', 'x')
    `;
    await insertContextItems(user, "google", null, [gmailItem(gmail("p1"))!, gmailItem(gmail("p2"))!]);
    const people = await peopleSummary(user, 3650);
    expect(people.map((p) => [p.address, p.items])).toEqual([
      ["bob@acme.com", 2],
      ["jane@acme.com", 2],
    ]);
  });

  it("catch-up reports distillation due while mail is waiting for a vector", async () => {
    const user = await createUser(state.t.sql);
    state.user = { id: user, tz: "UTC" };
    await insertContextItems(user, "google", null, [gmailItem(gmail("c1"))!]);
    await state.t.sql`insert into user_profile (user_id, distill_cursor) values (${user}, 9223372036854775807)`;

    const due = await (await handleCatchup(new Request("http://x/api/assist/catchup"))).json();
    expect(due.distillDue).toBe(true);

    await embedPendingItems(user, 10);
    const done = await (await handleCatchup(new Request("http://x/api/assist/catchup"))).json();
    expect(done.distillDue).toBe(false);
  });
});
