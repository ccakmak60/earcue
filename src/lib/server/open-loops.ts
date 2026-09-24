import "server-only";
import { sql } from "./db";
import { ANNOTATE_KINDS, SENSITIVE_ITEM_MIN } from "./item-signals";

// Open loops (memory architecture plan, Phase 4, migration 027): what is still open for the person.
// Detection and resolution are one SQL function, refresh_open_loops(), run by every catch-up
// (GET /api/assist/catchup), so there is no scheduled job and one call is one subrequest. The
// briefing (assist/briefing.ts) reads the open ones as its candidates, the `open_loops` tool reads
// them for the chat and the briefing's writer, and feedback on a recommendation made from one
// closes it (assist/suggest.ts).

export const LOOP_KINDS = ["reply_owed", "commitment", "waiting_on", "follow_up", "reconnect", "stale_project", "parked_idea"] as const;
export type LoopKind = (typeof LOOP_KINDS)[number];

// needs_reply at or above this, on an item the person did not write, opens a reply_owed loop.
export const LOOP_REPLY_MIN = 0.5;
// commitment at or above this opens a commitment loop. Higher than the reply bar: annotation gives
// 0.5 to a chat where the person only said they would come to lunch.
export const LOOP_COMMITMENT_MIN = 0.6;
// The contact floor: a silence counts only with someone the person was in touch with on at least
// this many days, and only when it is more than twice their usual gap and at least RECONNECT_QUIET_DAYS.
export const RECONNECT_MIN_CONTACTS = 4;
export const RECONNECT_QUIET_DAYS = 14;
// An active project or idea whose latest item is older than this is stale.
export const STALE_DAYS = 21;
// Items older than this open no loop, and their open loops expire; a loop nobody acted on expires
// after LOOP_OPEN_DAYS.
export const LOOP_MAX_AGE_DAYS = 45;
export const LOOP_OPEN_DAYS = 30;

// Why each kind is open, as the ranker and the writer are told.
export const LOOP_WHY: Record<string, string> = {
  reply_owed: "Someone asked the person something or is waiting on them, and the person has not replied in that conversation.",
  commitment: "The person promised to do something here.",
  waiting_on: "The person asked someone something days ago and has had no answer.",
  follow_up: "Something the person meant to follow up on.",
  reconnect: "The person has been out of touch with them for much longer than usual.",
  stale_project: "An active project of theirs with nothing new for weeks.",
  parked_idea: "An idea they kept, with nothing new for weeks.",
};

export interface LoopRefresh {
  opened: number;
  done: number;
  expired: number;
}

// Resolves what has closed since the last catch-up (a reply sent on the thread, a contact made,
// the project moved), expires what is too old, and opens what the signals show is newly open.
export async function refreshOpenLoops(userId: string): Promise<LoopRefresh> {
  const [row] = await sql`
    select refresh_open_loops(${userId}::uuid, ${LOOP_REPLY_MIN}::real, ${LOOP_COMMITMENT_MIN}::real, ${RECONNECT_MIN_CONTACTS}::int,
                              ${RECONNECT_QUIET_DAYS}::int, ${STALE_DAYS}::int, ${LOOP_MAX_AGE_DAYS}::int, ${LOOP_OPEN_DAYS}::int) as r
  `;
  const r = row.r ?? {};
  return { opened: Number(r.opened ?? 0), done: Number(r.done ?? 0), expired: Number(r.expired ?? 0) };
}

export interface LoopRow {
  id: string;
  kind: LoopKind;
  score: number;
  detectedAt: string;
  entity: { id: string; kind: string; name: string; status: string | null } | null;
  item: {
    id: string;
    provider: string;
    kind: string;
    title: string;
    body: string;
    ts: string;
    from: string | null;
    to: string | null;
    sent: boolean;
    threadKey: string | null;
  } | null;
  // A memory drawn from the item (a note's remembered memory), sensitive ones only when asked.
  memory: { id: string; text: string } | null;
  // reconnect: the person's usual gap between contacts, in days.
  usualGapDays: number | null;
}

const iso = (ts: unknown) => (ts ? new Date(ts as string).toISOString() : "");

// The open loops, highest score first. Loops resting on an item annotation called sensitive, or
// has not judged yet, are left out unless `includeSensitive` (the chat, on a turn the person
// typed): the briefing is a proactive surface (item-signals.ts), which never shows sensitive
// memories either. A loop resting on an entity alone is not held back. `notSuggestedDays` leaves out
// loops a recommendation was already made from in that many days, whatever its status, so the
// briefing does not raise one again while it is still on the For you feed.
export async function openLoops(
  userId: string,
  { kind = null, includeSensitive = false, limit = 12, bodyChars = 600, notSuggestedDays = 0 }: { kind?: string | null; includeSensitive?: boolean; limit?: number; bodyChars?: number; notSuggestedDays?: number } = {}
): Promise<LoopRow[]> {
  const rows = await sql`
    select l.id, l.kind, l.score, l.detected_at,
           e.id as entity_id, e.kind as entity_kind, e.name as entity_name, e.status as entity_status,
           ci.id as item_id, ci.provider, ci.kind as item_kind, ci.title, left(ci.body, ${bodyChars}) as body, ci.ts,
           ci.meta->>'from' as sender, ci.meta->>'to' as recipients, ci.meta->>'sent' as sent, ci.thread_key,
           m.id as memory_id, m.text as memory_text,
           case when l.kind = 'reconnect' then (select pa.median_gap_days from person_activity pa where pa.user_id = l.user_id and pa.entity_id = l.entity_id) end as usual_gap
    from open_loops l
    left join entities e on e.id = l.entity_id
    left join context_items ci on ci.id = l.context_item_id
    left join memories m on m.id = l.memory_id and m.forgotten_at is null and (${includeSensitive}::boolean or not m.sensitive)
    where l.user_id = ${userId} and l.status = 'open'
      and (${kind}::text is null or l.kind = ${kind}::text)
      and (${includeSensitive}::boolean or ci.id is null or ci.kind <> all(${ANNOTATE_KINDS}::text[])
           or (ci.signals_at is not null and coalesce((ci.signals->>'sensitive')::real, 1) < ${SENSITIVE_ITEM_MIN}))
      and (${notSuggestedDays}::int = 0 or not exists (
        select 1 from suggestions s where s.loop_id = l.id and s.ts > now() - (${notSuggestedDays} || ' days')::interval))
    order by l.score desc, l.detected_at desc, l.id desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind,
    score: Number(r.score),
    detectedAt: iso(r.detected_at),
    entity: r.entity_id ? { id: String(r.entity_id), kind: r.entity_kind, name: r.entity_name, status: r.entity_status ?? null } : null,
    item: r.item_id
      ? {
          id: String(r.item_id),
          provider: r.provider,
          kind: r.item_kind,
          title: r.title ?? "",
          body: r.body ?? "",
          ts: iso(r.ts),
          from: r.sender ?? null,
          to: r.recipients ?? null,
          sent: r.sent === "true",
          threadKey: r.thread_key ?? null,
        }
      : null,
    memory: r.memory_id ? { id: String(r.memory_id), text: r.memory_text } : null,
    usualGapDays: r.usual_gap === null || r.usual_gap === undefined ? null : Math.round(Number(r.usual_gap) * 10) / 10,
  }));
}

// Feedback on a recommendation reaches the loop it was made from: accepted marks it done,
// dismissed marks it dismissed, for good (detection never reopens a loop on the same item). Only an
// open loop changes, so a later dismissal does not undo an acceptance. One statement with the
// suggestion's own update.
export async function recordFeedback(userId: string, clientId: string, status: "shown" | "accepted" | "dismissed"): Promise<void> {
  const loopStatus = status === "accepted" ? "done" : status === "dismissed" ? "dismissed" : null;
  await sql`
    with s as (
      update suggestions set status = ${status} where user_id = ${userId} and client_id = ${clientId}
      returning loop_id
    )
    update open_loops l set status = ${loopStatus}::text, resolved_at = now()
    from s
    where ${loopStatus}::text is not null and l.id = s.loop_id and l.user_id = ${userId} and l.status = 'open'
  `;
}
