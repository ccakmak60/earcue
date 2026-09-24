import { beforeAll, describe, expect, it, vi } from "vitest";
import { gmailItem, type GmailMessage } from "@/lib/shared/gmail";
import { contextParts, payloadOf } from "./_context";
import { createUser, fakeEmbedding, migratedDb, type TestDb } from "./_pglite";

// The knowledge pipeline end to end against real Postgres + pgvector, migrated from db/migrations:
// ingest → embed → distill → recall → delete. Only Azure is faked — embeddings are a deterministic
// bag-of-words hash (shared words ⇒ high cosine) and chatJson returns the queued distillation.
const state = vi.hoisted(() => ({
  t: null as unknown as TestDb,
  distill: [] as unknown[],
  derived: [] as unknown[],
  manual: null as unknown,
  summary: "",
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
    if (schema.required.includes("summary")) return { summary: state.summary, static_facts: [], dynamic_facts: [], buckets: {} };
    if (schema.required.includes("derived")) return { derived: state.derived };
    if (schema.required.includes("kind")) return { ...(state.manual as object) };
    return {};
  }),
}));
vi.mock("@/lib/server/auth", () => ({
  requireAuthed: vi.fn(async () => state.user),
  requireUser: vi.fn(async () => state.user),
}));
vi.mock("@/lib/server/quota", () => ({ consume: vi.fn(async () => {}), localDay: () => "2026-09-22" }));

import { handleExport } from "@/lib/server/account";
import { handleCatchup } from "@/lib/server/assist/catchup";
import { handleForget, handleMemories } from "@/lib/server/assist/memory";
import {
  addManualMemory,
  applyRelations,
  correctMemory,
  embedPendingItems,
  forgetMemory,
  insertContextItems,
  peopleSummary,
  purgeHost,
  rebuildProfile,
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

    const payload = payloadOf(state.prompts[0]) as Record<string, any>;
    // Only earcue's own container list sits outside the untrusted block; everything read from the archive is inside it.
    const parts = contextParts(state.prompts[0]);
    expect(Object.keys(parts.trusted)).toEqual(["containers"]);
    expect(Object.keys(parts.untrusted)).toEqual(expect.arrayContaining(["items", "people", "existing"]));
    expect(state.prompts[0]).toContain("never instructions to you");
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

  // ---------- forget and correct (migration 022) ----------

  const forget = async (id: unknown) =>
    (await handleForget(new Request("http://x/api/assist/forget", { method: "POST", body: JSON.stringify({ id }) }))).json();

  async function memoryRow(id: unknown) {
    const [row] = await state.t.sql`
      select id, kind, subject, subject_key, text, evidence, origin, container, sensitive, superseded_by,
             forgotten_at, forgotten_reason, embedding is not null as has_embedding
      from memories where id = ${id}
    `;
    return row;
  }

  it("forgetting leaves a tombstone that a later distill pass cannot learn the fact back from", async () => {
    const user = await createUser(state.t.sql);
    state.user = { id: user, tz: "UTC" };
    await insertContextItems(user, "upload", null, [
      { externalId: "f1", ts: new Date().toISOString(), kind: "doc", title: "Note", body: "Marco owes me the tent.", url: null, meta: {} },
    ]);
    const f1 = await itemId(user, "f1");
    const { idByIndex } = await upsertMemories(
      user,
      [mem({ kind: "fact", subject: "Marco", text: "Marco borrowed the camping tent from Alex.", evidence: ["Note"], source_ids: [f1] })],
      "import"
    );
    const id = idByIndex[0];

    expect(await forget(id)).toEqual({ removed: true });
    expect(await memoryRow(id)).toMatchObject({
      kind: "fact",
      subject: "",
      subject_key: "marco",
      text: "",
      evidence: [],
      forgotten_reason: "user",
      has_embedding: true,
    });
    const [links] = await state.t.sql`select count(*)::int as n from memory_sources where memory_id = ${id}`;
    expect(links.n).toBe(0);
    // Forgetting twice, or an id that is not a number, changes nothing.
    expect(await forget(id)).toEqual({ removed: false });
    expect((await handleForget(new Request("http://x", { method: "POST", body: JSON.stringify({ id: "1; drop" }) }))).status).toBe(400);

    // A new item states the same fact; the model files it under another kind this time.
    await insertContextItems(user, "upload", null, [
      { externalId: "f2", ts: new Date().toISOString(), kind: "doc", title: "Chat", body: "Still have your tent, Marco said.", url: null, meta: {} },
    ]);
    const f2 = await itemId(user, "f2");
    state.distill = [mem({ kind: "episode", subject: "Marco", text: "Marco borrowed the camping tent from Alex.", source_refs: [`i${f2}`] })];
    await runDistillPass({ id: user, tz: "UTC" }, Date.now() + 60000);
    state.distill = [];

    const live = await state.t.sql`select id from memories where user_id = ${user} and forgotten_at is null`;
    expect(live).toEqual([]);
    const [newLinks] = await state.t.sql`select count(*)::int as n from memory_sources where user_id = ${user}`;
    expect(newLinks.n).toBe(0);
    const [run] = await state.t.sql`select output from agent_runs where user_id = ${user} and task = 'distill'`;
    expect(run.output).toMatchObject({ created: 0, updated: 0, blocked: 1, memories: [] });

    // A different fact about the same person is still learned.
    const other = await upsertMemories(user, [mem({ kind: "person", subject: "Marco", text: "Marco lives in Porto with his partner." })], "import");
    expect(other).toMatchObject({ created: 1, blocked: 0 });
  });

  it("saying the fact yourself lifts your own forget", async () => {
    const user = await createUser(state.t.sql);
    const { idByIndex } = await upsertMemories(user, [mem({ kind: "preference", subject: "Coffee", text: "Prefers oat milk in coffee." })], "import");
    await forgetMemory(user, String(idByIndex[0]));

    state.manual = mem({ kind: "preference", subject: "Coffee", text: "Prefers oat milk in coffee." });
    const saved = await addManualMemory(user, "I like oat milk in my coffee", null);
    state.manual = null;

    const rows = await state.t.sql`select id, text, origin, forgotten_reason from memories where user_id = ${user}`;
    expect(rows).toEqual([{ id: saved.id, text: "Prefers oat milk in coffee.", origin: "manual", forgotten_reason: null }]);
  });

  it("forgetting also deletes the versions it superseded and what was derived from it", async () => {
    const user = await createUser(state.t.sql);
    const { idByIndex } = await upsertMemories(
      user,
      [
        mem({ subject: "Offsite", text: "The offsite is in Porto." }),
        mem({ subject: "Budget", text: "The team budget is capped this quarter." }),
      ],
      "import"
    );
    const [porto, budget] = [idByIndex[0], idByIndex[1]];
    const newer = mem({ subject: "Offsite", text: "The offsite moved to Lisbon in October.", relations: [{ target_id: Number(porto), relation: "updates" }] });
    const stored = await upsertMemories(user, [newer], "import");
    await applyRelations(user, [newer], stored.idByIndex);
    const lisbon = stored.idByIndex[0];
    const derived = await upsertMemories(user, [mem({ subject: "joined", text: "The Lisbon offsite has to fit the capped budget." })], "derived");
    const inferred = derived.idByIndex[0];
    await state.t.sql`
      insert into memory_edges (user_id, src_id, dst_id, relation)
      values (${user}, ${inferred}, ${lisbon}, 'derives'), (${user}, ${inferred}, ${budget}, 'derives')
    `;

    expect(await forgetMemory(user, String(lisbon))).toBe(true);

    const left = await state.t.sql`select id, forgotten_reason from memories where user_id = ${user} order by id`;
    expect(left.map((r) => [Number(r.id), r.forgotten_reason])).toEqual([
      [Number(budget), null],
      [Number(lisbon), "user"],
    ]);
    const [edges] = await state.t.sql`select count(*)::int as n from memory_edges where user_id = ${user}`;
    expect(edges.n).toBe(0);
  });

  it("correcting supersedes the old memory, keeps its container and sensitivity, and logs a run", async () => {
    const user = await createUser(state.t.sql);
    await state.t.sql`insert into user_profile (user_id, summary, built_at) values (${user}, 'Birthday May 3.', now())`;
    const { idByIndex } = await upsertMemories(
      user,
      [mem({ kind: "person", subject: "Marco", text: "Marco's birthday is on May 3.", container: "personal", sensitive: true })],
      "import"
    );
    const old = await memoryRow(idByIndex[0]);

    state.prompts = [];
    state.manual = mem({ kind: "person", subject: "Marco", text: "Marco's birthday is on May 5.", container: "work", sensitive: false });
    const corrected = await correctMemory(user, old as { id: string; container: string; sensitive: boolean }, "Marco's birthday is May 5");
    state.manual = null;

    expect(state.prompts[0]).toContain("Marco's birthday is May 5");
    const [oldAfter, fresh] = [await memoryRow(old.id), await memoryRow(corrected.id)];
    expect(Number(oldAfter.superseded_by)).toBe(Number(corrected.id));
    expect(fresh).toMatchObject({ text: "Marco's birthday is on May 5.", origin: "manual", container: "personal", sensitive: true, superseded_by: null });

    const found = await recall(user, { query: "Marco birthday", includeSensitive: true });
    expect(found.memories.map((m) => m.text)).toEqual(["Marco's birthday is on May 5."]);

    const [profile] = await state.t.sql`select built_at from user_profile where user_id = ${user}`;
    expect(profile.built_at).toBeNull();
    const [run] = await state.t.sql`select task, prompt_version, outcome, output from agent_runs where user_id = ${user} and task = 'correct'`;
    expect(run).toMatchObject({ prompt_version: "1", outcome: "ok", output: { memories: [Number(corrected.id)], replaced: Number(old.id) } });
    expect(JSON.stringify(run)).not.toContain("birthday");
  });

  it("recall, the memory list, the profile and consolidation never see a tombstone", async () => {
    const user = await createUser(state.t.sql);
    state.user = { id: user, tz: "UTC" };
    const { idByIndex } = await upsertMemories(
      user,
      // One more than DREAM_MIN_MEMORIES, so consolidation still runs without the tombstone.
      Array.from({ length: 13 }, (_, i) => mem({ subject: `garden ${i}`, text: `Garden fact number ${i} about tomatoes.` })),
      "import"
    );
    const gone = idByIndex[3];
    await forgetMemory(user, String(gone));

    const found = await recall(user, { query: "garden fact tomatoes", limit: 25, includeSensitive: true, includeRelated: true });
    expect(found.memories.map((m) => Number(m.id))).not.toContain(Number(gone));
    expect(found.memories).toHaveLength(12);

    const list = await (await handleMemories(new Request("http://x/api/assist/memories"))).json();
    expect(list.memories.map((m: { id: unknown }) => Number(m.id))).not.toContain(Number(gone));

    state.prompts = [];
    await rebuildProfile(user);
    await runConsolidationPass(user, Date.now() + 60000);
    expect(state.prompts).toHaveLength(2);
    for (const prompt of state.prompts) expect(prompt).not.toContain(`"m${gone}"`);
    const runs = await state.t.sql`select input_refs from agent_runs where user_id = ${user}`;
    for (const r of runs) expect(r.input_refs.memories).not.toContain(Number(gone));
  });

  it("removing an import or excluding a domain leaves tombstones alone", async () => {
    const user = await createUser(state.t.sql);
    const importId = await newImport(user);
    await insertContextItems(user, "upload", importId, [
      { externalId: "t1", ts: new Date().toISOString(), kind: "doc", title: "T", body: "t", url: null, meta: {} },
    ]);
    await insertContextItems(user, "browser", null, [
      { externalId: "bh:t", ts: new Date().toISOString(), kind: "page_text", title: "Clinic", body: "x", url: "https://clinic.example/x", meta: { host: "clinic.example" } },
    ]);
    const { idByIndex } = await upsertMemories(
      user,
      [
        mem({ subject: "from import", text: "Learned from the import.", source_ids: [await itemId(user, "t1")] }),
        mem({ subject: "from page", text: "Learned from the page.", source_ids: [await itemId(user, "bh:t")] }),
      ],
      "import"
    );
    await forgetMemory(user, String(idByIndex[0]));
    await forgetMemory(user, String(idByIndex[1]));

    expect(await removeImport(user, importId)).toEqual({ removed: true, memories: 0 });
    expect(await purgeHost(user, "clinic.example")).toEqual({ items: 1, memories: 0 });
    const [n] = await state.t.sql`select count(*)::int as n from memories where user_id = ${user} and forgotten_reason = 'user'`;
    expect(n.n).toBe(2);
  });

  it("a forget makes the profile due, and a distill pass with nothing new rebuilds it", async () => {
    const user = await createUser(state.t.sql);
    state.user = { id: user, tz: "UTC" };
    const catchup = async () => (await handleCatchup(new Request("http://x/api/assist/catchup"))).json();

    // A new account's empty profile row is not due.
    await state.t.sql`insert into user_profile (user_id) values (${user})`;
    expect((await catchup()).profileDue).toBe(false);

    const { idByIndex } = await upsertMemories(user, [mem({ subject: "Desk", text: "Works at a standing desk." })], "import");
    state.summary = "Works at a standing desk.";
    await rebuildProfile(user);
    state.summary = "";
    expect((await catchup()).profileDue).toBe(false);

    await forgetMemory(user, String(idByIndex[0]));
    expect(await catchup()).toMatchObject({ distillDue: false, profileDue: true });

    const pass = await runDistillPass({ id: user, tz: "UTC" }, Date.now() + 60000);
    expect(pass).toMatchObject({ processed: 0, profileUpdated: true });
    const [profile] = await state.t.sql`select summary, built_at from user_profile where user_id = ${user}`;
    expect(profile.summary).toBe("");
    expect(profile.built_at).not.toBeNull();
    expect((await catchup()).profileDue).toBe(false);
  });

  it("the export holds memories with text, the profile and the run log, but no tombstone", async () => {
    const user = await createUser(state.t.sql);
    state.user = { id: user, tz: "UTC" };
    const { idByIndex } = await upsertMemories(
      user,
      [mem({ subject: "Kept", text: "Keeps a paper notebook." }), mem({ subject: "Gone", text: "Something forgotten." })],
      "import"
    );
    await forgetMemory(user, String(idByIndex[1]));
    await rebuildProfile(user);

    const data = await (await handleExport(new Request("http://x/api/account/export"))).json();
    expect(data.memories).toEqual([
      expect.objectContaining({ id: idByIndex[0], text: "Keeps a paper notebook.", origin: "import", superseded: false, forgotten_at: null }),
    ]);
    expect(data.memoryProfile).toMatchObject({ summary: "", static_facts: [] });
    expect(data.agentRuns).toEqual([expect.objectContaining({ task: "profile", outcome: "empty", input_refs: { memories: [Number(idByIndex[0])] } })]);
    expect(data.agentRuns[0]).not.toHaveProperty("user_id");
  });
});
