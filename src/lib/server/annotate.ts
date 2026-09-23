import "server-only";
import { sql } from "./db";
import { decide, type Answer, type Question } from "./decide";
import { entityContext } from "./entities";
import { env } from "./env";
import { ANNOTATE_KINDS } from "./item-signals";
import { Run, type Prompt } from "./harness/runs";
import { InvalidOutput } from "./llm";
import { consume } from "./quota";

// Item signals (memory architecture plan, Phases 1 to 3, migrations 024 and 026): every
// text-bearing item is asked a few fixed questions once, packed up to ANNOTATE_PACK items to a model
// call, and the answers are stored on the item. Distill reads triage and salience to choose and
// order its batch (knowledge.ts, TRIAGE_GATE). The `entity` answer routes the item to one of the
// person's known entities (item_entities, as `mention` or `topic`). needs_reply and commitment open
// loops (open-loops.ts, migration 027), and triage, salience and `sensitive` choose the briefing's
// candidates (assist/briefing.ts). The client runs this through POST /api/assist/annotate before
// it asks for a distill pass.

// The kinds annotation reads live in item-signals.ts, beside the sensitivity rule that reads them.
export { ANNOTATE_KINDS };

// Answered calls that may leave one item out before annotation stops asking about it.
export const ANNOTATE_MAX_ATTEMPTS = 3;
const ANNOTATE_ITEM_CHARS = 1500;
// A pack is not started with less time than this left before the caller's deadline.
const ANNOTATE_MIN_MS = 5000;
// Packs in flight at once, as the tool loop runs its calls (harness/loop.ts MAX_PARALLEL): each holds
// one fetch or one query at a time, inside a Worker's six open connections.
const ANNOTATE_PARALLEL = 3;

// Subrequests, as harness/loop.ts counts them against Workers Free's 50 per request, for one
// POST /api/assist/annotate: the session (counted as two) and the users row, the spend ceiling's
// once-per-isolate read, the pending read, the `annotations` charge, the entity read, the run
// row's insert and update, and the remaining count; then per packed call its fetch, its metering
// write and its update (which also stores the entity links).
// tests/unit/server/harness/subrequests.test.ts checks both against the code.
export const ANNOTATE_FIXED_SUBREQUESTS = 10;
export const ANNOTATE_PACK_SUBREQUESTS = 3;
// The same 40 of 50 the tool loop keeps to (LOOP_SUBREQUEST_BUDGET), leaving room for what is
// not counted.
const ANNOTATE_SUBREQUEST_BUDGET = 40;

export function annotatePack(): number {
  return Math.max(1, Number(env.ANNOTATE_PACK) || 20);
}

// The most items one request annotates: ANNOTATE_BATCH, cut to the packs that fit the budget
// (10 packs, 200 items at the default pack of 20).
export function annotateBatch(): number {
  const packs = Math.floor((ANNOTATE_SUBREQUEST_BUDGET - ANNOTATE_FIXED_SUBREQUESTS) / ANNOTATE_PACK_SUBREQUESTS);
  const batch = Number(env.ANNOTATE_BATCH);
  return Math.max(0, Math.min(Number.isFinite(batch) ? batch : 200, packs * annotatePack()));
}

export const TRIAGE = ["drop", "keep", "key"] as const;

export const ANNOTATE_QUESTIONS: readonly Question[] = [
  {
    key: "triage",
    kind: "choice",
    options: TRIAGE,
    text:
      "`drop`: automated or bulk content with nothing the person would want remembered or acted on (newsletters, marketing, digests, receipts, " +
      "one-time codes, delivery and account notifications, build or system alerts). `key`: it matters to the person: a request or question " +
      "to them, a promise they made or were made, a decision, a deadline, money, health, travel, or close family and friends. `keep`: " +
      "anything else worth remembering.",
  },
  { key: "salience", kind: "score", scale: [0, 1], text: "How much this item matters to the person, from 0 (not at all) to 1 (a great deal)." },
  {
    key: "needs_reply",
    kind: "probability",
    text: "Does the person still owe a reply: someone other than the person asked them something or is waiting on them, and the item was not written by the person.",
  },
  { key: "commitment", kind: "probability", text: "Does the item contain a promise or commitment by the person to do something." },
  { key: "sensitive", kind: "probability", text: "Does the item reveal the person's health, money or debts, legal matters or intimate life." },
];

// Entities offered to the `entity` question, latest first: the choice is one of these or `none`.
export const ANNOTATE_ENTITY_CHOICES = 60;

// Asked only when the person has entities to route to. Its options are `none` and the `option` of
// each entity the state lists (e<id>), never names, so no imported text reaches the schema.
export const ENTITY_QUESTION_TEXT =
  "Which one of the listed `entities` the item is mainly about, beyond who sent or received it: a person it discusses, " +
  "or a project, idea, organisation or place it concerns. `none` when none of them is.";

export function entityQuestion(options: readonly string[]): Question {
  return { key: "entity", kind: "choice", options: ["none", ...options], text: ENTITY_QUESTION_TEXT };
}

// The questions' texts are part of what the model reads, so a change to them bumps the version too.
export const ANNOTATE_PROMPT: Prompt = {
  version: "2",
  text:
    "You label items from one person's archive: their mail, chats, calendar, documents, pages they read and notes they wrote " +
    "to themselves (kind `note`). Each item in the untrusted block has a number `n`; the questions are asked about every item " +
    "separately. An email with `sent: true` was written by the person; any other email was sent to them. A chat lists who took " +
    "part in `with`, and a chat line by any name in `you` was written by the person. Judge each item on its own text. " +
    `Questions: ${[...ANNOTATE_QUESTIONS.map((q) => q.key), "entity"].join(", ")}.`,
};

export interface AnnotatingUser {
  id: string;
  tz: string | null;
  plan: string;
  unlimited?: boolean | null;
}

interface PendingItem {
  id: number;
  provider: string;
  kind: string;
  title: string | null;
  body: string | null;
  ts: Date | string;
  meta: Record<string, unknown> | null;
  participants: string[] | null;
}

// One item as the state shows it: numbered, the body clipped, direction and people from the meta.
export function stateItem(n: number, r: PendingItem): Record<string, unknown> {
  const item: Record<string, unknown> = {
    n: String(n),
    source: r.provider,
    kind: r.kind,
    date: new Date(r.ts).toISOString().slice(0, 10),
    title: String(r.title || "").slice(0, 200),
  };
  if (r.kind === "email") {
    item.from = String(r.meta?.from || "").slice(0, 200);
    item.to = String(r.meta?.to || "").slice(0, 200);
    item.sent = r.meta?.sent === true;
  } else if (Array.isArray(r.participants) && r.participants.length > 0) {
    item.with = r.participants.slice(0, 8);
  }
  item.body = String(r.body || "").slice(0, ANNOTATE_ITEM_CHARS);
  return item;
}

export interface Annotated {
  // Items that got every answer.
  annotated: number;
  // Items the model left out, or answered off the scale; they stay pending.
  missing: number;
  // Model calls made (packs).
  calls: number;
}

const NONE: Annotated = { annotated: 0, missing: 0, calls: 0 };

// Annotates up to `limit` pending items, newest first, ANNOTATE_PACK to a call and up to
// ANNOTATE_PARALLEL calls at once, as one `annotate` run. Charged to the `annotations` metric, one
// unit per item read, before any model call; past the cap it throws QuotaExceeded (the action's
// 429). Answers land in one statement per call. An item the model leaves out has its attempts
// counted and stays pending; a failed call (a network error, the deadline, the spend ceiling)
// counts nothing, lets the calls already in flight finish, and throws after the run row is written.
// No pack starts within ANNOTATE_MIN_MS of `deadline`.
export async function annotatePendingItems(user: AnnotatingUser, limit: number, deadline: number): Promise<Annotated> {
  if (limit <= 0) return NONE;
  const rows = (await sql`
    select id, provider, kind, title, body, ts, meta, participants from context_items
    where user_id = ${user.id} and signals_at is null and kind = any(${ANNOTATE_KINDS}::text[])
      and coalesce((signals->>'attempts')::int, 0) < ${ANNOTATE_MAX_ATTEMPTS}
      and (title || body) ~ '\\S'
    order by id desc limit ${limit}
  `) as PendingItem[];
  if (rows.length === 0) return NONE;

  await consume({ id: user.id, tz: user.tz || "UTC", plan: user.plan, unlimited: user.unlimited }, "annotations", rows.length);

  // The person's own names (trusted), and the entities an item can be routed to (read from their
  // archive, so they go in the untrusted state with the items).
  const { you, known } = await entityContext(user.id, ANNOTATE_ENTITY_CHOICES);
  const options = known.map((e) => `e${e.id}`);
  const questions = options.length > 0 ? [...ANNOTATE_QUESTIONS, entityQuestion(options)] : ANNOTATE_QUESTIONS;
  const entities = known.map((e) => ({ option: `e${e.id}`, kind: e.kind, name: e.name }));

  const run = new Run(user.id, "annotate", ANNOTATE_PROMPT, env.MODEL_ANNOTATE);
  for (const r of rows) run.refs.item(r.id);
  const pack = annotatePack();
  const chunks: PendingItem[][] = [];
  for (let start = 0; start < rows.length; start += pack) chunks.push(rows.slice(start, start + pack));
  const out: Annotated = { annotated: 0, missing: 0, calls: 0 };
  const triage: Record<string, number> = {};
  let dropped = 0;
  let redacted = 0;
  let invalid = 0;
  let routed = 0;
  let failure: unknown = null;

  async function annotateChunk(chunk: PendingItem[]) {
    const about = chunk.map((_, i) => String(i + 1));
    let answers: (Record<string, Answer> | null)[] = chunk.map(() => null);
    let model = run.model;
    out.calls++;
    try {
      const result = await decide({
        instruction: ANNOTATE_PROMPT.text,
        state: { items: chunk.map((r, i) => stateItem(i + 1, r)), ...(entities.length > 0 ? { entities } : {}) },
        trusted: { you },
        questions,
        about,
        userId: user.id,
        run,
        deadlineMs: Math.max(0, deadline - Date.now()),
      });
      answers = about.map((n) => result.answers.get(n) ?? null);
      model = result.model;
      dropped += result.dropped;
      redacted += result.redacted;
    } catch (err) {
      // An answer that fails the schema even after the nudge counts against every item in the
      // pack, as if each were left out, so a pack the model cannot answer leaves the queue in time.
      if (!(err instanceof InvalidOutput)) throw err;
      invalid++;
    }
    await storeSignals(user.id, chunk, answers, model);
    for (const a of answers) {
      if (a) {
        out.annotated++;
        triage[String(a.triage)] = (triage[String(a.triage)] ?? 0) + 1;
        if (typeof a.entity === "string" && a.entity !== "none") routed++;
      } else out.missing++;
    }
  }

  // Each worker takes the next pack until none is left, time runs short, or a call has failed.
  let next = 0;
  async function worker() {
    while (next < chunks.length && failure === null && deadline - Date.now() > ANNOTATE_MIN_MS) {
      const chunk = chunks[next++];
      try {
        await annotateChunk(chunk);
      } catch (err) {
        failure ??= err;
      }
    }
  }

  await run.track(async () => {
    await Promise.all(Array.from({ length: Math.min(ANNOTATE_PARALLEL, chunks.length) }, worker));
    run.output = {
      annotated: out.annotated,
      missing: out.missing,
      calls: out.calls,
      triage,
      ...(options.length > 0 ? { entity_choices: options.length, routed } : {}),
      ...(invalid > 0 ? { invalid_calls: invalid } : {}),
      ...(dropped > 0 ? { range_dropped: dropped } : {}),
      ...(redacted > 0 ? { redacted } : {}),
    };
    run.settle(out.annotated, dropped + invalid);
    if (failure !== null) throw failure;
  });
  return out;
}

// Items still waiting for signals: the ones annotatePendingItems would take, however many.
export async function annotationsPending(userId: string): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from context_items
    where user_id = ${userId} and signals_at is null and kind = any(${ANNOTATE_KINDS}::text[])
      and coalesce((signals->>'attempts')::int, 0) < ${ANNOTATE_MAX_ATTEMPTS}
      and (title || body) ~ '\\S'
  `;
  return row.n;
}

// One statement per call: an answered item gets its signals and leaves the queue; one left out
// stays pending with its attempts counted. An item routed to an entity is linked to it, as
// `mention` for a person and `topic` for anything else; the option was one this call offered, and
// the join keeps it to this account's entities.
async function storeSignals(userId: string, chunk: PendingItem[], answers: (Record<string, Answer> | null)[], model: string) {
  const num = (a: Record<string, Answer> | null, key: string) => (a ? Number(a[key]) : null);
  const entityOf = (a: Record<string, Answer> | null) => (a && typeof a.entity === "string" && /^e\d+$/.test(a.entity) ? a.entity.slice(1) : null);
  await sql`
    with links as (
      insert into item_entities (context_item_id, entity_id, user_id, role)
      select x.id, e.id, ${userId}::uuid, case when e.kind = 'person' then 'mention' else 'topic' end
      from unnest(${chunk.map((r) => r.id)}::bigint[], ${answers.map(entityOf)}::bigint[]) as x(id, entity_id)
      join entities e on e.id = x.entity_id and e.user_id = ${userId}::uuid
      join context_items c on c.id = x.id and c.user_id = ${userId}::uuid
      on conflict do nothing
      returning 1
    )
    update context_items ci set
      triage = coalesce(x.triage, ci.triage),
      salience = coalesce(x.salience, ci.salience),
      needs_reply = coalesce(x.needs_reply, ci.needs_reply),
      commitment = coalesce(x.commitment, ci.commitment),
      signals = case when x.triage is null
        then jsonb_build_object('attempts', coalesce((ci.signals->>'attempts')::int, 0) + 1)
        else jsonb_strip_nulls(jsonb_build_object('sensitive', x.sensitive, 'entity', x.entity_id)) end,
      signals_model = case when x.triage is null then ci.signals_model else ${model} end,
      signals_at = case when x.triage is null then null else now() end
    from unnest(${chunk.map((r) => r.id)}::bigint[], ${answers.map((a) => (a ? String(a.triage) : null))}::text[],
                ${answers.map((a) => num(a, "salience"))}::real[], ${answers.map((a) => num(a, "needs_reply"))}::real[],
                ${answers.map((a) => num(a, "commitment"))}::real[], ${answers.map((a) => num(a, "sensitive"))}::real[],
                ${answers.map(entityOf)}::bigint[])
      as x(id, triage, salience, needs_reply, commitment, sensitive, entity_id)
    where ci.id = x.id and ci.user_id = ${userId} and ci.signals_at is null
  `;
}
