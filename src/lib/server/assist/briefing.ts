import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "../db";
import { decide, type Answer, type Question } from "../decide";
import { env } from "../env";
import { SpendCeilingReached } from "../errors";
import { keepCited } from "../harness/check";
import { buildContext, contextMessages, UNTRUSTED_RULE, type Section } from "../harness/context";
import { MODEL_CALL_SUBREQUESTS, runLoop } from "../harness/loop";
import { Run, type Prompt } from "../harness/runs";
import { READ_TOOLS } from "../harness/tools";
import { profileFor } from "../knowledge";
import { InvalidOutput, readJsonAnswer, type JsonSchema } from "../llm";
import { logError } from "../log";
import { LOOP_WHY, openLoops, type LoopRow } from "../open-loops";

// The briefing (memory architecture plan, "Recommendations"; harness plan step 9): three steps
// instead of one prompt holding everything recent.
//   1. Candidates, by SQL: open loops (open-loops.ts), events in the next 24 hours with the people
//      on them and when the person last heard from each, and recent messages annotation marked
//      `key` (or has not judged yet) that no loop covers.
//   2. Rank, by decide() (task `rank`, its own run): per candidate, is it worth interrupting the
//      person today, how urgent is it, and would it repeat a recommendation already made or one
//      they dismissed. If that call fails, the SQL order stands.
//   3. Write, by MODEL_REASON (task `briefing`): only the top three, each with the rest of its
//      conversation and the memories about the people and projects on it. It may look things up
//      once before answering (runLoop, maxSteps 2, decision H1) and answers in JSON.
// The output check (refs valid), the untrusted block and redaction apply to both model steps.

// ---------- candidates ----------

const LOOP_CANDIDATES = 16;
const EVENT_CANDIDATES = 6;
const RECENT_CANDIDATES = 8;
const RECENT_HOURS = 72;
// What the writer reads of each candidate's item; the ranker reads less.
const ITEM_CHARS = 1500;
const RANK_ITEM_CHARS = 500;
const THREAD_ITEMS = 4;
const THREAD_ITEM_CHARS = 600;
const CANDIDATE_MEMORIES = 12;

export const EVENT_WHY = "On their calendar in the next 24 hours.";
export const RECENT_WHY = "A message from the last three days that looks important to them.";

export interface Candidate {
  // c1, c2, …: the ranker's subject and the writer's `candidate`.
  key: string;
  source: "loop" | "event" | "recent";
  // The loop kind, or `event` / `recent`.
  kind: string;
  loopId: string | null;
  itemId: string;
  entityId: string | null;
  memoryId: string | null;
  threadKey: string | null;
  // What the ranker and the writer are told about it, apart from the ref.
  view: Record<string, unknown>;
  body: string;
}

const clip = (v: unknown, n: number) => {
  const s = String(v ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const dateOf = (ts: unknown) => (ts ? new Date(ts as string).toISOString().slice(0, 16).replace("T", " ") : null);

function loopCandidate(l: LoopRow): Omit<Candidate, "key"> | null {
  if (!l.item) return null;
  const view: Record<string, unknown> = {
    why: l.kind,
    reason: LOOP_WHY[l.kind],
    source: l.item.provider,
    kind: l.item.kind,
    date: dateOf(l.item.ts),
    title: clip(l.item.title, 200),
  };
  if (l.item.kind === "email") {
    view.from = clip(l.item.from, 200);
    if (l.item.sent) view.to = clip(l.item.to, 200);
    view.sent = l.item.sent;
  }
  if (l.entity) view.about = l.entity.kind === "person" ? l.entity.name : `${l.entity.kind} ${l.entity.name}`;
  if (l.kind === "reconnect") {
    view.last_contact = dateOf(l.item.ts);
    if (l.usualGapDays !== null) view.usual_gap_days = l.usualGapDays;
  }
  if (l.memory) view.remembered = l.memory.text;
  return {
    source: "loop",
    kind: l.kind,
    loopId: l.id,
    itemId: l.item.id,
    entityId: l.entity?.id ?? null,
    memoryId: l.memory?.id ?? null,
    threadKey: l.item.threadKey,
    view,
    body: l.item.body,
  };
}

async function eventCandidates(userId: string) {
  return sql`
    select ci.id, ci.title, left(ci.body, 300) as body, ci.ts, ci.meta->>'location' as location,
           (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'last_contact', p.last_contact)), '[]'::jsonb)
            from (
              select e.name,
                     (select max(c2.ts) from item_entities i2 join context_items c2 on c2.id = i2.context_item_id
                      where i2.entity_id = e.id and i2.role in ('from', 'to') and c2.kind <> 'event' and c2.ts <= now()) as last_contact
              from (select distinct entity_id from item_entities where context_item_id = ci.id) x
              join entities e on e.id = x.entity_id and e.kind = 'person' and not e.is_self
              order by e.name limit 6
            ) p) as people
    from context_items ci
    where ci.user_id = ${userId} and ci.kind = 'event'
      and ci.ts between now() - interval '2 hours' and now() + interval '24 hours'
    order by ci.ts asc
    limit ${EVENT_CANDIDATES}
  `;
}

// Recent messages to the person that annotation marked `key`, or has not judged yet (so a failed
// annotation pass hides nothing), and that no loop rests on, whatever its status: a dismissed
// reply_owed does not come back this way.
async function recentCandidates(userId: string) {
  return sql`
    select ci.id, ci.provider, ci.kind, ci.title, left(ci.body, ${ITEM_CHARS}) as body, ci.ts,
           ci.meta->>'from' as sender, ci.thread_key
    from context_items ci
    where ci.user_id = ${userId} and ci.kind in ('email', 'message', 'chat')
      and ci.ts > now() - (${RECENT_HOURS} || ' hours')::interval
      and (ci.triage = 'key' or ci.signals_at is null)
      and ci.meta->>'sent' is distinct from 'true'
      and not exists (select 1 from open_loops l where l.context_item_id = ci.id)
    order by coalesce(ci.salience, 0.5) desc, ci.ts desc
    limit ${RECENT_CANDIDATES}
  `;
}

// Loops first (by score), then events (soonest first), then recent messages (by salience): the
// order the fallback keeps when ranking fails.
export function mergeCandidates(
  loops: LoopRow[],
  events: Record<string, unknown>[],
  recent: Record<string, unknown>[]
): Candidate[] {
  const out: Omit<Candidate, "key">[] = [];
  for (const l of loops) {
    const c = loopCandidate(l);
    if (c) out.push(c);
  }
  for (const e of events) {
    out.push({
      source: "event",
      kind: "event",
      loopId: null,
      itemId: String(e.id),
      entityId: null,
      memoryId: null,
      threadKey: null,
      view: {
        why: "event",
        reason: EVENT_WHY,
        kind: "event",
        date: dateOf(e.ts),
        title: clip(e.title, 200),
        ...(e.location ? { location: clip(e.location, 120) } : {}),
        people: ((e.people as { name: string; last_contact: string | null }[]) ?? []).map((p) => ({ name: p.name, last_contact: dateOf(p.last_contact) })),
      },
      body: String(e.body ?? ""),
    });
  }
  for (const r of recent) {
    out.push({
      source: "recent",
      kind: "recent",
      loopId: null,
      itemId: String(r.id),
      entityId: null,
      memoryId: null,
      threadKey: (r.thread_key as string) ?? null,
      view: {
        why: "recent",
        reason: RECENT_WHY,
        source: r.provider,
        kind: r.kind,
        date: dateOf(r.ts),
        title: clip(r.title, 200),
        ...(r.sender ? { from: clip(r.sender, 200) } : {}),
      },
      body: String(r.body ?? ""),
    });
  }
  return out.map((c, i) => ({ ...c, key: `c${i + 1}` }));
}

// ---------- rank ----------

export const RANK_QUESTIONS: readonly Question[] = [
  {
    key: "worth",
    kind: "probability",
    text:
      "Is it worth interrupting the person about this today: a reply they owe or a promise they made that is still open, a deadline or an " +
      "event to prepare for, someone they would want to get back to. Not worth it: newsletters, marketing, automated notices, something " +
      "already done, long past or not theirs to act on, and small talk.",
  },
  { key: "urgency", kind: "score", scale: [0, 1], text: "How soon it needs them: 1 today or overdue, 0.5 within the week, 0 no time pressure." },
  {
    key: "repeat",
    kind: "probability",
    text: "Would recommending it repeat a recommendation in `already`, or resemble one in `not_useful`, even in other words.",
  },
];

// The questions' texts are part of what the model reads, so a change to them bumps the version too.
export const RANK_PROMPT: Prompt = {
  version: "1",
  text:
    "You choose what earcue brings to one person's attention today. Each candidate in the untrusted block has a key `c`, " +
    "`why` it was picked (reply_owed, commitment, waiting_on, reconnect, stale_project, parked_idea, event or recent) with its " +
    "`reason`, and the item it rests on; `date` is when that item was written or, for an event, when it happens. `today` is " +
    "the person's date. `already` are recommendations made this week and `not_useful` ones they dismissed. `profile_static` " +
    "and `profile_dynamic` say who they are and what they are working on. Judge each candidate on its own. " +
    `Questions: ${RANK_QUESTIONS.map((q) => q.key).join(", ")}.`,
};

// A candidate is written up only when the ranker thinks it is worth it and not a repeat.
export const RANK_MIN_WORTH = 0.5;
export const RANK_MAX_REPEAT = 0.5;
export const BRIEFING_TOP = 3;

export interface Ranked {
  // The candidates to write, best first.
  top: Candidate[];
  // `decide` when the ranker answered, `fallback` when it failed and the SQL order stood.
  by: "decide" | "fallback";
}

// The ranker's answers turned into the top candidates: worthy, not repeats, by worth plus half the
// urgency, ties kept in SQL order. A candidate the answer left out is not written.
export function pickTop(candidates: Candidate[], answers: Map<string, Record<string, Answer>>): Candidate[] {
  const score = (a: Record<string, Answer>) => Number(a.worth) + 0.5 * Number(a.urgency);
  return candidates
    .map((c, i) => ({ c, i, a: answers.get(c.key) }))
    .filter((x): x is { c: Candidate; i: number; a: Record<string, Answer> } => Boolean(x.a) && Number(x.a!.worth) >= RANK_MIN_WORTH && Number(x.a!.repeat) < RANK_MAX_REPEAT)
    .sort((x, y) => score(y.a) - score(x.a) || x.i - y.i)
    .slice(0, BRIEFING_TOP)
    .map((x) => x.c);
}

interface Trusted {
  today: string;
  already: string[];
  notUseful: string[];
  profile: string;
  profileStatic: unknown[];
  profileDynamic: unknown[];
}

// One decide() call over every candidate, as its own `rank` run. Any failure but the spend ceiling
// leaves the SQL order: the run row records the failure and the briefing's output says `fallback`.
export async function rankCandidates(userId: string, candidates: Candidate[], trusted: Trusted, deadlineMs: number): Promise<Ranked> {
  const run = new Run(userId, "rank", RANK_PROMPT, env.MODEL_ANNOTATE);
  for (const c of candidates) run.refs.item(c.itemId);
  try {
    const top = await run.track(async () => {
      const result = await decide({
        instruction: RANK_PROMPT.text,
        state: { candidates: candidates.map((c) => ({ c: c.key, ...c.view, body: clip(c.body, RANK_ITEM_CHARS) })) },
        trusted: {
          today: trusted.today,
          already: trusted.already,
          not_useful: trusted.notUseful,
          profile_static: trusted.profileStatic,
          profile_dynamic: trusted.profileDynamic,
        },
        questions: RANK_QUESTIONS,
        about: candidates.map((c) => c.key),
        userId,
        run,
        deadlineMs,
      });
      // An answer that covers no candidate is a failed ranking, not a verdict that nothing matters.
      if (result.answers.size === 0) throw new InvalidOutput("rank: no candidate answered");
      const picked = pickTop(candidates, result.answers);
      const answered = [...result.answers.values()];
      run.output = {
        candidates: candidates.length,
        answered: answered.length,
        worth: answered.filter((a) => Number(a.worth) >= RANK_MIN_WORTH).length,
        repeats: answered.filter((a) => Number(a.repeat) >= RANK_MAX_REPEAT).length,
        chosen: picked.map((c) => Number(c.itemId)),
        ...(result.dropped > 0 ? { range_dropped: result.dropped } : {}),
        ...(result.redacted > 0 ? { redacted: result.redacted } : {}),
      };
      run.settle(answered.length, result.dropped);
      return picked;
    });
    return { top, by: "decide" };
  } catch (err) {
    if (err instanceof SpendCeilingReached) throw err;
    logError("briefing_rank_failed", err, { userId });
    return { top: candidates.slice(0, BRIEFING_TOP), by: "fallback" };
  }
}

// ---------- write ----------

// Each prompt's `version` is recorded in agent_runs; bump it whenever the text changes.
export const BRIEFING_PROMPT: Prompt = {
  version: "3",
  text:
    "You are a personal assistant for one person. From everything they imported (mail, chats, calendar, documents and notes), earcue has " +
    "already picked up to three things worth their attention today, in `candidates`: each has a `key`, `why` it was picked with its `reason`, " +
    "and the item it rests on. `conversation` holds the rest of each candidate's conversation, `memories` what earcue remembers about the " +
    "people and projects involved, and `today` is the person's date. There is no live activity.\n" +
    "Write at most one recommendation per candidate, and only for a candidate that still needs them: skip one that is already handled, " +
    "past, or not theirs to act on. reminder for a promise they made, a deadline, or an event to prepare for; draft when a reply or " +
    "follow-up is owed (put the full sendable text in draft_text, in their voice and language); idea for a concrete next move on something " +
    "they are working on, or for getting back in touch with someone; mistake when two things they wrote or scheduled contradict each other. " +
    "Set `candidate` to the key it answers. Write each title as a short imperative a busy person can act on, and each detail as one or two " +
    "plain sentences with no jargon.\n" +
    "Most candidates need nothing more. When one does, you may look things up once before answering: `thread` (the rest of a conversation), " +
    "`person`, `entity`, `recall`, `search_items`, `calendar`, `open_loops`.\n" +
    "Every item and memory you are given or look up carries a `ref`. Each evidence entry names one of those refs in `ref` and quotes the " +
    "subject, title or words that matter in `quote`; a recommendation with no valid ref is discarded. " +
    "Never repeat a title from `already`, and suggest nothing similar to `not_useful`, which they dismissed. " +
    "Address people and projects by their real names. Memories flagged sensitive are never included here. An empty array is fine when " +
    "nothing is worth saying. `profile_static` are facts that are always true about them; `profile_dynamic` is what they are working on right now. " +
    UNTRUSTED_RULE,
};

export function briefingSchema(keys: readonly string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            candidate: { type: "string", enum: keys },
            kind: { type: "string", enum: ["idea", "mistake", "draft", "reminder", "answer"] },
            title: { type: "string" },
            detail: { type: "string" },
            draft_text: { type: "string" },
            evidence: {
              type: "array",
              items: {
                type: "object",
                properties: { ref: { type: "string" }, quote: { type: "string" } },
                required: ["ref", "quote"],
              },
            },
            urgency: { type: "string", enum: ["low", "medium", "high"] },
            confidence: { type: "number" },
          },
          required: ["candidate", "kind", "title", "detail", "evidence", "urgency", "confidence"],
        },
      },
    },
    required: ["suggestions"],
  };
}

interface Produced {
  candidate: string;
  kind: string;
  title: string;
  detail: string;
  draft_text?: string;
  evidence?: { ref: string; quote: string }[];
  urgency: string;
  confidence: number;
}

// The write step's payload, most important first, as the old single-call briefing budgeted its
// sections: earcue's own lists and profile, then the three candidates, their conversations and the
// memories about them (all read from the archive, so all untrusted).
const WRITE_CONTEXT_TOKENS = 12_000;

function writeSections(trusted: Trusted, top: Candidate[], conversation: Record<string, unknown>[], memories: Record<string, unknown>[]): Section[] {
  return [
    { key: "today", value: trusted.today, tokens: 50 },
    { key: "already", value: trusted.already, tokens: 800 },
    { key: "not_useful", value: trusted.notUseful, tokens: 400 },
    { key: "profile", value: trusted.profile, tokens: 400 },
    { key: "profile_static", value: trusted.profileStatic, tokens: 300 },
    { key: "profile_dynamic", value: trusted.profileDynamic, tokens: 300 },
    {
      key: "candidates",
      value: top.map((c) => ({ id: c.itemId, key: c.key, ...c.view, body: c.body })),
      tokens: 3000,
      ref: "items",
      untrusted: true,
    },
    { key: "conversation", value: conversation, tokens: 3000, ref: "items", untrusted: true },
    { key: "memories", value: memories, tokens: 1500, ref: "memories", untrusted: true },
  ];
}

// The rest of each chosen candidate's conversation (its latest THREAD_ITEMS other items) and the
// memories about it: linked to its entity, drawn from its item, or the loop's own memory. Sensitive
// memories never; two reads, side by side.
async function writeContext(userId: string, top: Candidate[]) {
  const threads = [...new Set(top.map((c) => c.threadKey).filter((k): k is string => Boolean(k)))];
  const items = top.map((c) => c.itemId);
  const entities = top.map((c) => c.entityId).filter((e): e is string => Boolean(e));
  const mems = top.map((c) => c.memoryId).filter((m): m is string => Boolean(m));
  const keyOf = new Map(top.filter((c) => c.threadKey).map((c) => [c.threadKey, c.key]));
  const [thread, memories] = await Promise.all([
    sql`
      select id, thread_key, kind, title, body, ts, sender, sent from (
        select ci.id, ci.thread_key, ci.kind, ci.title, left(ci.body, ${THREAD_ITEM_CHARS}) as body, ci.ts,
               ci.meta->>'from' as sender, ci.meta->>'sent' as sent,
               row_number() over (partition by ci.thread_key order by ci.ts desc) as n
        from context_items ci
        where ci.user_id = ${userId} and ci.thread_key = any(${threads}::text[]) and not (ci.id = any(${items}::bigint[]))
      ) t
      where n <= ${THREAD_ITEMS}
      order by thread_key, ts
    `,
    sql`
      select m.id, m.kind, m.subject, m.text, e.name as about
      from memories m left join entities e on e.id = m.entity_id
      where m.user_id = ${userId} and m.superseded_by is null and m.forgotten_at is null and not m.sensitive
        and (m.expires_at is null or m.expires_at > now())
        and (m.entity_id = any(${entities}::bigint[]) or m.id = any(${mems}::bigint[])
             or exists (select 1 from memory_sources s where s.memory_id = m.id and s.context_item_id = any(${items}::bigint[])))
      order by m.importance desc, m.last_seen_at desc
      limit ${CANDIDATE_MEMORIES}
    `,
  ]);
  return {
    conversation: thread.map((r) => ({
      id: r.id,
      of: keyOf.get(r.thread_key) ?? null,
      kind: r.kind,
      date: dateOf(r.ts),
      title: clip(r.title, 200),
      ...(r.sender ? { from: clip(r.sender, 200), sent: r.sent === "true" } : {}),
      body: r.body ?? "",
    })),
    memories: memories.map((m) => ({ id: m.id, kind: m.kind, subject: m.subject, text: m.text, ...(m.about ? { about: m.about } : {}) })),
  };
}

export function dedupKeyFor(title: string): string {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

// ---------- subrequests ----------

// What one briefing request uses, as the tool loop counts it against Workers Free's 50 (see H3):
// before the candidates, the session (counted as two), the users row, the timezone update and the
// assist_calls charge; the candidate reads (profile, loops, events, recent messages, titles); the
// rank run (its row twice, the spend ceiling's once-per-isolate read, its fetch and metering); the
// write context (two reads); and at the end one insert of the suggestions. The write step's loop
// adds its own run row and model calls and runs tools only while they fit.
// tests/unit/server/harness/subrequests.test.ts measures a briefing against these.
export const BRIEFING_PRELUDE_SUBREQUESTS = 5;
export const BRIEFING_READ_SUBREQUESTS = 5;
export const RANK_SUBREQUESTS = 2 + 1 + MODEL_CALL_SUBREQUESTS;
export const WRITE_CONTEXT_SUBREQUESTS = 2;
export const BRIEFING_INSERT_SUBREQUESTS = 1;
export const BRIEFING_WRITE_STEPS = 2;

// ---------- the task ----------

function todayIn(tz: string | null): string {
  try {
    return new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz || "UTC" });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export interface BriefingRow {
  id: string | number;
  client_id: string;
  kind: string;
  title: string;
  detail: string;
  draft_text: string | null;
  evidence: unknown;
  urgency: string;
  confidence: number;
}

// One briefing, after the gate: candidates, rank, write. Returns the suggestions stored.
export async function runBriefing(user: { id: string; tz: string | null }, day: string): Promise<BriefingRow[]> {
  const started = Date.now();
  const budget = Number(env.LOOP_SUBREQUEST_BUDGET);
  let spent = BRIEFING_PRELUDE_SUBREQUESTS + BRIEFING_READ_SUBREQUESTS;

  // Five independent reads, under the Worker's six open connections.
  const [profileRow, loops, events, recent, titles] = await Promise.all([
    profileFor(user.id),
    openLoops(user.id, { limit: LOOP_CANDIDATES, bodyChars: ITEM_CHARS, notSuggestedDays: 7 }),
    eventCandidates(user.id),
    recentCandidates(user.id),
    // This week's titles (never repeat) plus a month of dismissals (never suggest anything like them).
    sql`
      select title, status from suggestions
      where user_id = ${user.id} and local_day > ${day}::date - 30 and local_day <= ${day}::date
        and (status = 'dismissed' or local_day > ${day}::date - 7)
      order by ts desc limit 60
    `,
  ]);
  const trusted: Trusted = {
    today: todayIn(user.tz),
    already: titles.map((r) => r.title),
    notUseful: titles.filter((r) => r.status === "dismissed").map((r) => r.title),
    profile: profileRow?.summary || "",
    profileStatic: profileRow?.static || [],
    profileDynamic: profileRow?.dynamic || [],
  };
  const candidates = mergeCandidates(loops, events, recent);

  const ranked: Ranked | null = candidates.length > 0 ? await rankCandidates(user.id, candidates, trusted, 20_000) : null;
  if (ranked) spent += RANK_SUBREQUESTS;
  const top = ranked?.top ?? [];

  const run = new Run(user.id, "briefing", BRIEFING_PROMPT, env.MODEL_REASON);
  const summary = {
    candidates: candidates.length,
    ...(ranked ? { ranked_by: ranked.by } : {}),
    chosen: top.map((c) => c.kind),
    loops: top.map((c) => (c.loopId ? Number(c.loopId) : null)).filter((l): l is number => l !== null),
  };

  // Nothing worth writing up: no model call, only the run row saying so.
  if (top.length === 0) {
    await run.track(async () => {
      run.output = summary;
      run.settle(0);
    });
    return [];
  }

  const { conversation, memories } = await writeContext(user.id, top);
  spent += WRITE_CONTEXT_SUBREQUESTS;
  const context = buildContext(run.refs, writeSections(trusted, top, conversation, memories), WRITE_CONTEXT_TOKENS);
  const { messages, redacted } = contextMessages(run.prompt.text, context.trusted, context.untrusted);
  const byKey = new Map(top.map((c) => [c.key, c]));
  const schema = briefingSchema(top.map((c) => c.key));

  return runLoop(
    {
      run,
      tools: READ_TOOLS,
      messages,
      // A pipeline, never the person's own turn: the tools return no sensitive memory.
      userAsked: false,
      deadline: started + 60_000,
      maxSteps: BRIEFING_WRITE_STEPS,
      subrequestBudget: budget - BRIEFING_INSERT_SUBREQUESTS,
      spent,
      maxTokens: 1500,
      schema,
      systemRule: false,
    },
    async (result) => {
      if (result.text === null) throw new Error(`briefing: no answer (${result.stopped})`);
      const answer = readJsonAnswer<{ suggestions: Produced[] }>(result.text, schema, run.meter);
      // Only evidence citing a ref this run sent (the context, or a tool result) survives; a
      // suggestion left with none is dropped.
      const { kept, dropped, badRefs } = keepCited(answer.suggestions || [], run.refs);
      const rows = kept.map((s) => ({ s, clientId: randomUUID(), loopId: byKey.get(s.candidate)?.loopId ?? null }));
      const inserted =
        rows.length === 0
          ? []
          : ((await sql`
              insert into suggestions (user_id, client_id, local_day, kind, title, detail, draft_text, evidence, urgency, confidence, dedup_key, run_id, loop_id)
              select ${user.id}::uuid, x.client_id, ${day}::date, x.kind, x.title, x.detail, nullif(x.draft_text, ''), x.evidence::jsonb,
                     x.urgency, x.confidence, x.dedup_key, ${run.id}::uuid, x.loop_id
              from unnest(${rows.map((r) => r.clientId)}::text[], ${rows.map((r) => r.s.kind)}::text[], ${rows.map((r) => r.s.title)}::text[],
                          ${rows.map((r) => r.s.detail)}::text[], ${rows.map((r) => r.s.draft_text || "")}::text[],
                          ${rows.map((r) => JSON.stringify(r.s.evidence))}::text[], ${rows.map((r) => r.s.urgency)}::text[],
                          ${rows.map((r) => r.s.confidence)}::real[], ${rows.map((r) => dedupKeyFor(r.s.title))}::text[],
                          ${rows.map((r) => r.loopId)}::bigint[])
                as x(client_id, kind, title, detail, draft_text, evidence, urgency, confidence, dedup_key, loop_id)
              on conflict (user_id, dedup_key, local_day) do nothing
              returning id, client_id, kind, title, detail, draft_text, evidence, urgency, confidence
            `) as BriefingRow[]);
      const order = new Map<string, number>(rows.map((r, i) => [r.clientId, i]));
      inserted.sort((a, b) => (order.get(a.client_id) ?? 0) - (order.get(b.client_id) ?? 0));
      run.output = {
        ...run.output,
        ...summary,
        suggestions: inserted.map((r) => Number(r.id)),
        duplicates: kept.length - inserted.length,
        dropped,
        bad_refs: badRefs,
        context_tokens: context.tokens,
        ...(Object.keys(context.cut).length > 0 ? { context_cut: context.cut } : {}),
        ...(redacted > 0 ? { redacted } : {}),
      };
      run.settle(kept.length, dropped);
      return inserted;
    }
  );
}
