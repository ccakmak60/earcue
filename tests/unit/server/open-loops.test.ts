import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, fakeEmbedding, migratedDb, type TestDb } from "./_pglite";

// Open loops (migration 027) against the migrated schema: refresh_open_loops() detects and resolves
// them from item signals and entities, feedback on a recommendation closes the loop it came from,
// and openLoops() is what the briefing and the tool read. Items go in through insertContextItems,
// so participants are linked to people as in production; signals are written directly, as the
// annotate pass would.
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

import { confirmWhatsappSelf, linkMemoryEntities } from "@/lib/server/entities";
import { insertContextItems, insertNote, upsertMemories } from "@/lib/server/knowledge";
import { LOOP_MAX_AGE_DAYS, openLoops, recordFeedback, RECONNECT_MIN_CONTACTS, refreshOpenLoops } from "@/lib/server/open-loops";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ME = "Alex <alex@example.com>";
let user: string;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function email(id: string, msAgo: number, from: string, subject: string, body: string, thread: string, to = ME) {
  return { externalId: `gm:${id}`, ts: ago(msAgo), kind: "email", title: subject, body, url: null, meta: { from, to, threadId: thread, sent: from === ME } };
}

async function idOf(externalId: string): Promise<number> {
  const [row] = await state.t.sql`select id from context_items where user_id = ${user} and external_id = ${externalId}`;
  return Number(row.id);
}

// What the annotate pass would have written.
async function signal(externalId: string, s: { needs_reply?: number; commitment?: number; triage?: string; salience?: number; sensitive?: number }) {
  await state.t.sql`
    update context_items set triage = ${s.triage ?? "keep"}, salience = ${s.salience ?? 0.6}, needs_reply = ${s.needs_reply ?? 0},
           commitment = ${s.commitment ?? 0}, signals = ${JSON.stringify(s.sensitive === undefined ? {} : { sensitive: s.sensitive })}::jsonb,
           signals_at = now()
    where user_id = ${user} and external_id = ${externalId}
  `;
}

async function loops() {
  return state.t.sql`
    select l.id, l.kind, l.status, l.entity_id, l.memory_id, l.resolved_at, ci.external_id, e.name as entity
    from open_loops l left join context_items ci on ci.id = l.context_item_id left join entities e on e.id = l.entity_id
    where l.user_id = ${user} order by l.id
  `;
}

beforeAll(async () => {
  state.t = await migratedDb();
}, 60000);

beforeEach(async () => {
  user = await createUser(state.t.sql);
});

describe("reply_owed", () => {
  it("opens for an unanswered request and closes when a later sent item lands on the same thread", async () => {
    await insertContextItems(user, "google", null, [
      email("ask", 2 * DAY, "Priya Nair <priya@acme.example>", "Pricing", "Could you send the tiers by Thursday?", "th-1"),
      email("answered", 3 * DAY, "Lena Park <lena@acme.example>", "Copy", "Is the banner copy right?", "th-2"),
      email("answer", 2.5 * DAY, ME, "Re: Copy", "Yes, go ahead.", "th-2", "Lena Park <lena@acme.example>"),
      email("digest", DAY, "Digest <news@digest.example>", "Weekly", "Reply to get the report!", "th-3"),
    ]);
    await signal("gm:ask", { needs_reply: 0.9, triage: "key" });
    await signal("gm:answered", { needs_reply: 0.9 });
    await signal("gm:answer", { needs_reply: 0 });
    // Automated mail that asks for a reply is not owed one.
    await signal("gm:digest", { needs_reply: 0.8, triage: "drop" });

    expect(await refreshOpenLoops(user)).toEqual({ opened: 1, done: 0, expired: 0 });
    expect(await loops()).toMatchObject([{ kind: "reply_owed", status: "open", external_id: "gm:ask", entity: "Priya Nair" }]);

    // A second refresh opens nothing new.
    expect((await refreshOpenLoops(user)).opened).toBe(0);

    await insertContextItems(user, "google", null, [email("reply", HOUR, ME, "Re: Pricing", "Here are the tiers.", "th-1", "Priya Nair <priya@acme.example>")]);
    expect(await refreshOpenLoops(user)).toMatchObject({ done: 1, opened: 0 });
    const [loop] = await loops();
    expect(loop).toMatchObject({ status: "done" });
    expect(loop.resolved_at).not.toBeNull();
  });

  it("closes on a later WhatsApp block the person spoke in, once their WhatsApp name is theirs", async () => {
    const chat = (ts: string, participants: string[], body: string) => ({ externalId: `wa:marco:${ts}`, ts, kind: "chat", title: "WhatsApp — Marco", body, url: null, meta: { chat: "Marco", participants } });
    const first = chat(ago(3 * DAY), ["Marco", "Alex"], "Marco: can you send me the photos?");
    await insertContextItems(user, "whatsapp", null, [first]);
    expect(await confirmWhatsappSelf(user, "Alex")).toBe(true);
    await signal(first.externalId, { needs_reply: 0.9 });
    await refreshOpenLoops(user);
    expect(await loops()).toMatchObject([{ kind: "reply_owed", status: "open", entity: "Marco" }]);

    // A later block from Marco alone answers nothing; one Alex spoke in does.
    await insertContextItems(user, "whatsapp", null, [chat(ago(2 * DAY), ["Marco"], "Marco: hello?")]);
    await refreshOpenLoops(user);
    expect((await loops()).filter((l) => l.status === "open")).toHaveLength(1);
    await insertContextItems(user, "whatsapp", null, [chat(ago(DAY), ["Alex"], "Alex: sent them!")]);
    await refreshOpenLoops(user);
    expect((await loops()).find((l) => l.external_id === first.externalId)).toMatchObject({ status: "done" });
  });

  it("keeps one open loop per thread: a newer request replaces the older one", async () => {
    await insertContextItems(user, "google", null, [email("a1", 3 * DAY, "Tom <tom@acme.example>", "Deck", "Can you review?", "th-9")]);
    await signal("gm:a1", { needs_reply: 0.9 });
    await refreshOpenLoops(user);
    await insertContextItems(user, "google", null, [email("a2", DAY, "Tom <tom@acme.example>", "Re: Deck", "Any news?", "th-9")]);
    await signal("gm:a2", { needs_reply: 0.9 });
    await refreshOpenLoops(user);
    expect((await loops()).map((l) => [l.external_id, l.status])).toEqual([
      ["gm:a1", "expired"],
      ["gm:a2", "open"],
    ]);
  });
});

describe("feedback", () => {
  async function suggestionFor(loopId: string, clientId: string) {
    await state.t.sql`
      insert into suggestions (user_id, client_id, local_day, kind, title, urgency, dedup_key, loop_id)
      values (${user}, ${clientId}, current_date, 'draft', 'Reply to Priya', 'high', ${clientId}, ${loopId})
    `;
  }

  it("a dismissed loop stays dismissed: refresh never reopens it and nothing reads it as open", async () => {
    await insertContextItems(user, "google", null, [email("ask", DAY, "Priya Nair <priya@acme.example>", "Pricing", "Could you send the tiers?", "th-1")]);
    await signal("gm:ask", { needs_reply: 0.9 });
    await refreshOpenLoops(user);
    const [loop] = await loops();
    await suggestionFor(loop.id, "s1");

    await recordFeedback(user, "s1", "dismissed");
    expect(await loops()).toMatchObject([{ status: "dismissed" }]);
    const [s] = await state.t.sql`select status from suggestions where client_id = 's1'`;
    expect(s.status).toBe("dismissed");

    // The same item keeps asking, the signals are rewritten, a catch-up runs again: still dismissed.
    await signal("gm:ask", { needs_reply: 1 });
    expect(await refreshOpenLoops(user)).toEqual({ opened: 0, done: 0, expired: 0 });
    expect(await loops()).toMatchObject([{ status: "dismissed" }]);
    expect(await openLoops(user)).toEqual([]);
    // A later acceptance of the same suggestion does not reopen or change it either.
    await recordFeedback(user, "s1", "accepted");
    expect(await loops()).toMatchObject([{ status: "dismissed" }]);
  });

  it("accepted marks the loop done; shown changes nothing; another account's suggestion is untouched", async () => {
    await insertContextItems(user, "google", null, [email("ask", DAY, "Priya Nair <priya@acme.example>", "Pricing", "Could you send the tiers?", "th-1")]);
    await signal("gm:ask", { needs_reply: 0.9 });
    await refreshOpenLoops(user);
    const [loop] = await loops();
    await suggestionFor(loop.id, "s2");

    await recordFeedback(user, "s2", "shown");
    expect(await loops()).toMatchObject([{ status: "open" }]);
    const other = await createUser(state.t.sql);
    await recordFeedback(other, "s2", "dismissed");
    expect(await loops()).toMatchObject([{ status: "open" }]);
    await recordFeedback(user, "s2", "accepted");
    expect(await loops()).toMatchObject([{ status: "done" }]);
  });
});

describe("reconnect", () => {
  // One exchange per listed day, both ways, as a chat would be.
  async function history(name: string, address: string, daysAgo: number[]) {
    await insertContextItems(
      user,
      "google",
      null,
      daysAgo.flatMap((d, i) => [
        email(`${name}-in-${i}`, d * DAY, `${name} <${address}>`, "Catch up", "How are you?", `th-${name}-${i}`),
        email(`${name}-out-${i}`, d * DAY - HOUR, ME, "Re: Catch up", "All good!", `th-${name}-${i}`, `${name} <${address}>`),
      ])
    );
  }

  it("fires only above the contact floor, for someone the person writes to, after a long silence", async () => {
    // Every few days for a while, then silent for a month: fires.
    await history("Rita", "rita@x.example", [30, 33, 36, 39, 42]);
    // The same silence, but in touch on fewer days than the floor: does not.
    await history("Sam", "sam@x.example", [30, 33, 36].slice(0, RECONNECT_MIN_CONTACTS - 1));
    // Daily mail the person never answers (a newsletter): never a relationship to reconnect.
    await insertContextItems(
      user,
      "google",
      null,
      [30, 31, 32, 33, 34, 35].map((d) => email(`nl-${d}`, d * DAY, "News <news@x.example>", "Daily", "Today's news", `th-nl-${d}`))
    );
    // In touch every three days and quiet for only four: not a silence yet.
    await history("Lena", "lena@x.example", [4, 7, 10, 13, 16]);

    await refreshOpenLoops(user);
    const open = await loops();
    expect(open.map((l) => [l.kind, l.entity])).toEqual([["reconnect", "Rita"]]);
    // It rests on the last contact.
    expect(open[0].external_id).toBe("gm:Rita-out-0");

    // A new contact ends the silence.
    await insertContextItems(user, "google", null, [email("Rita-new", HOUR, "Rita <rita@x.example>", "Hi", "Long time!", "th-rita-new")]);
    await refreshOpenLoops(user);
    expect(await loops()).toMatchObject([{ kind: "reconnect", status: "done" }]);
  });
});

describe("commitment", () => {
  it("a task note from Ask earcue becomes a commitment loop with the memory remembered from it", async () => {
    const note = await insertNote(user, "Remind me: I need to renew my passport before the Porto trip.", "run-1");
    const { idByIndex } = await upsertMemories(
      user,
      [{ kind: "goal", subject: "Passport", text: "Alex needs to renew their passport before the Porto trip.", importance: 0.8, confidence: 0.95, source_ids: [note] }],
      "chat"
    );
    await linkMemoryEntities(user, [{ memoryId: idByIndex[0], kind: "project", name: "Porto trip" }]);
    await state.t.sql`update context_items set triage = 'key', salience = 0.7, commitment = 0.9, needs_reply = 0, signals = '{}', signals_at = now() where id = ${note}`;

    await refreshOpenLoops(user);
    const [loop] = await loops();
    expect(loop).toMatchObject({ kind: "commitment", status: "open", entity: "Porto trip" });
    expect(String(loop.memory_id)).toBe(String(idByIndex[0]));
    const [read] = await openLoops(user);
    expect(read).toMatchObject({ kind: "commitment", item: { kind: "note" }, memory: { text: "Alex needs to renew their passport before the Porto trip." } });
  });

  it("counts the person's own promises only: a sent email or a chat, never a received email", async () => {
    await insertContextItems(user, "google", null, [
      email("mine", DAY, ME, "Deck", "I'll send you the deck on Friday.", "th-1", "Tom <tom@acme.example>"),
      email("theirs", DAY, "Bank <no-reply@bank.example>", "Plan", "Your instalments start on the 1st.", "th-2"),
    ]);
    await signal("gm:mine", { commitment: 0.9 });
    await signal("gm:theirs", { commitment: 0.9 });
    await refreshOpenLoops(user);
    expect((await loops()).map((l) => [l.kind, l.external_id, l.entity])).toEqual([["commitment", "gm:mine", "Tom"]]);
  });
});

describe("waiting_on", () => {
  it("opens on a question the person sent that is still last on its thread after three days, and closes on the answer", async () => {
    await insertContextItems(user, "google", null, [
      email("q", 5 * DAY, ME, "Venue", "Can you confirm the venue for the 14th? Thanks.", "th-q", "Rui <rui@venue.example>"),
      email("fresh", DAY, ME, "Other", "Are you free Monday?", "th-f", "Rui <rui@venue.example>"),
      email("plain", 5 * DAY, ME, "Notes", "Notes from today attached.", "th-p", "Rui <rui@venue.example>"),
    ]);
    await refreshOpenLoops(user);
    expect((await loops()).map((l) => [l.kind, l.external_id, l.entity])).toEqual([["waiting_on", "gm:q", "Rui"]]);
    await insertContextItems(user, "google", null, [email("a", HOUR, "Rui <rui@venue.example>", "Re: Venue", "Confirmed.", "th-q")]);
    await refreshOpenLoops(user);
    expect((await loops()).find((l) => l.external_id === "gm:q")).toMatchObject({ status: "done" });
  });
});

describe("stale projects and parked ideas", () => {
  it("an active project with a memory and nothing new for three weeks is stale until an item about it arrives", async () => {
    await insertContextItems(user, "google", null, [email("atlas", 30 * DAY, "Tom <tom@acme.example>", "Atlas", "Atlas kickoff notes.", "th-a")]);
    const item = await idOf("gm:atlas");
    const { idByIndex } = await upsertMemories(
      user,
      [{ kind: "project", subject: "Atlas", text: "Atlas is the onboarding redesign Alex leads.", importance: 0.8, confidence: 0.9, source_ids: [item] }],
      "import"
    );
    await linkMemoryEntities(user, [{ memoryId: idByIndex[0], kind: "project", name: "Atlas" }]);
    // An idea with no item about it at all is left alone: nothing to rest the loop on.
    const { idByIndex: idea } = await upsertMemories(user, [{ kind: "goal", subject: "Pottery", text: "Alex wants a pottery studio.", importance: 0.6, confidence: 0.9 }], "manual");
    await linkMemoryEntities(user, [{ memoryId: idea[0], kind: "idea", name: "Pottery studio" }]);

    await refreshOpenLoops(user);
    expect(await loops()).toMatchObject([{ kind: "stale_project", status: "open", entity: "Atlas", external_id: "gm:atlas" }]);

    const [entity] = await state.t.sql`select id from entities where user_id = ${user} and kind = 'project'`;
    await insertContextItems(user, "google", null, [email("atlas2", HOUR, "Tom <tom@acme.example>", "Atlas", "Atlas is back on.", "th-a2")]);
    await state.t.sql`insert into item_entities (context_item_id, entity_id, user_id, role) values (${await idOf("gm:atlas2")}, ${entity.id}, ${user}, 'topic')`;
    await refreshOpenLoops(user);
    expect(await loops()).toMatchObject([{ kind: "stale_project", status: "done" }]);
  });
});

describe("expiry", () => {
  it("opens nothing on an item past the age limit and expires a loop left open too long", async () => {
    await insertContextItems(user, "google", null, [
      email("old", (LOOP_MAX_AGE_DAYS + 1) * DAY, "Priya <priya@acme.example>", "Old", "Could you check this?", "th-old"),
      email("ask", 2 * DAY, "Priya <priya@acme.example>", "New", "Could you check this?", "th-new"),
    ]);
    await signal("gm:old", { needs_reply: 0.9 });
    await signal("gm:ask", { needs_reply: 0.9 });
    await refreshOpenLoops(user);
    expect((await loops()).map((l) => l.external_id)).toEqual(["gm:ask"]);

    await state.t.sql`update open_loops set detected_at = now() - interval '31 days' where user_id = ${user}`;
    expect(await refreshOpenLoops(user)).toMatchObject({ expired: 1 });
    expect(await loops()).toMatchObject([{ status: "expired" }]);
  });
});

describe("openLoops()", () => {
  it("leaves out loops on a sensitive item unless asked, and loops a recommendation was made from this week", async () => {
    await insertContextItems(user, "google", null, [
      email("clinic", DAY, "Clinic <agenda@clinic.example>", "Results", "Please call us about your results?", "th-c"),
      email("ask", DAY, "Priya <priya@acme.example>", "Pricing", "Could you send the tiers?", "th-p"),
      email("deck", DAY, "Tom <tom@acme.example>", "Deck", "Could you review the deck?", "th-d"),
    ]);
    await signal("gm:clinic", { needs_reply: 0.9, sensitive: 0.9 });
    await signal("gm:ask", { needs_reply: 0.9, salience: 0.9 });
    await signal("gm:deck", { needs_reply: 0.9, salience: 0.2 });
    await refreshOpenLoops(user);

    expect((await openLoops(user)).map((l) => l.item?.title)).toEqual(["Pricing", "Deck"]);
    expect((await openLoops(user, { includeSensitive: true })).map((l) => l.item?.title).sort()).toEqual(["Deck", "Pricing", "Results"]);
    expect(await openLoops(user, { kind: "commitment" })).toEqual([]);

    const [deck] = (await loops()).filter((l) => l.external_id === "gm:deck");
    await state.t.sql`
      insert into suggestions (user_id, client_id, local_day, kind, title, urgency, dedup_key, loop_id)
      values (${user}, 's-deck', current_date, 'reminder', 'Review the deck', 'low', 's-deck', ${deck.id})
    `;
    expect((await openLoops(user, { notSuggestedDays: 7 })).map((l) => l.item?.title)).toEqual(["Pricing"]);
  });
});
