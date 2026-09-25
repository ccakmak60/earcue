import "server-only";
import { createHash } from "node:crypto";
import { requireAuthed } from "../auth";
import { sql } from "../db";
import { decide, type Question } from "../decide";
import { env } from "../env";
import { SpendCeilingReached } from "../errors";
import { Run, type Prompt } from "../harness/runs";
import { MODEL_CALL_SUBREQUESTS } from "../harness/loop";
import { ANNOTATE_KINDS, SENSITIVE_ITEM_MIN } from "../item-signals";
import { profileFor } from "../knowledge";
import { InvalidOutput } from "../llm";
import { logError } from "../log";
import { openLoops } from "../open-loops";
import { consume } from "../quota";
import { json, readJson } from "../respond";
import { eventsAhead, todayIn } from "./briefing";
import {
  applyPanelAction,
  fingerprintText,
  LOOP_PANELS,
  parsePanelKey,
  pickPanels,
  type DashboardOut,
  type EntityCard,
  type Panel,
  type PanelAction,
  type PanelData,
  type PanelScore,
} from "@/lib/shared/dashboard";

// The Dashboard view (docs/plans/2026-09-25-feat-generative-dashboard-plan.md): a page of panels
// chosen for one person, built like the briefing.
//   1. Candidates, by SQL: every panel in the catalog (src/lib/shared/dashboard.ts) that has data
//      behind it, entity cards for the people, organisations and projects the person deals with
//      most, pinned panels always, hidden ones never.
//   2. If the candidates and their banded counts are what the stored page was built from, and it
//      is less than a day old, nothing more happens: no model call, no charge.
//   3. Decide (task `dashboard`, MODEL_ANNOTATE, like every System 1 call): per candidate, would the
//      person look at it most working days, and how central is it to their work right now. The
//      state is counts, dates and names, never an item's text.
//   4. pickPanels(): pins first, the useful ones by score under the caps, the fixed order when the
//      call fails. Stored in `dashboards` (migration 030).
// GET dashboard reads each chosen panel live. Panels are proactive, like For you: raw items only
// once annotated and judged not sensitive, sensitive memories never (item-signals.ts, decision G1).

export const DASHBOARD_REBUILD_HOURS = 24;

// Entity cards offered: the busiest people (at least PERSON_MIN_ITEMS in 90 days), organisations
// and active projects.
const PERSON_CARDS = 6;
const PERSON_MIN_ITEMS = 5;
const ORG_CARDS = 3;
const ORG_MIN_ITEMS = 3;
const PROJECT_CARDS = 3;
const PROJECTS_MIN = 2;
const PULSE_MIN_ITEMS = 50;
const TOPICS_MIN = 3;

const ENTRIES = 8;

// ---------- candidates ----------

interface Candidate {
  key: string;
  // What the fingerprint bands.
  count: number;
  // What the model reads about it: the panel in words and its numbers.
  view: Record<string, unknown>;
}

const daysSince = (ts: unknown) => (ts ? Math.max(0, Math.round((Date.now() - new Date(ts as string).getTime()) / 86400_000)) : null);
const iso = (ts: unknown) => (ts ? new Date(ts as string).toISOString() : null);

// Open loops per kind, under the proactive rule, as the loop panels would list them.
async function loopCounts(userId: string) {
  return sql`
    select l.kind, count(*)::int as n, count(distinct l.entity_id)::int as entities, min(coalesce(ci.ts, l.detected_at)) as oldest
    from open_loops l
    left join context_items ci on ci.id = l.context_item_id
    where l.user_id = ${userId} and l.status = 'open'
      and (ci.id is null or ci.kind <> all(${ANNOTATE_KINDS}::text[])
           or (ci.signals_at is not null and coalesce((ci.signals->>'sensitive')::real, 1) < ${SENSITIVE_ITEM_MIN}))
    group by l.kind
  `;
}

// People, organisations, projects and ideas with their activity in 90 days (items annotation did not
// call noise, so a newsletter sender is not a busy contact), open loops and non-sensitive memories,
// ranked within each kind, plus any the person pinned.
async function entityRows(userId: string) {
  return sql`
    with activity as (
      select ie.entity_id, count(distinct ci.id)::int as items_90d, max(ci.ts) as last_seen
      from context_items ci join item_entities ie on ie.context_item_id = ci.id
      where ci.user_id = ${userId} and ci.ts > now() - interval '90 days' and ci.ts <= now() and ci.triage is distinct from 'drop'
      group by ie.entity_id
    ), loops as (
      select entity_id, count(*)::int as n from open_loops
      where user_id = ${userId} and status = 'open' and entity_id is not null
      group by entity_id
    ), mems as (
      select entity_id, count(*)::int as n from memories
      where user_id = ${userId} and entity_id is not null and forgotten_at is null and superseded_by is null
        and not sensitive and (expires_at is null or expires_at > now())
      group by entity_id
    ), scored as (
      select e.id, e.kind, e.name, e.status, coalesce(a.items_90d, 0) as items_90d, a.last_seen,
             coalesce(l.n, 0) as loops, coalesce(m.n, 0) as memories,
             exists (select 1 from dashboards d where d.user_id = e.user_id and ('entity:' || e.id) = any(d.pinned)) as pinned,
             row_number() over (partition by e.kind order by coalesce(a.items_90d, 0) desc, coalesce(l.n, 0) desc, coalesce(m.n, 0) desc, e.id) as rn
      from entities e
      left join activity a on a.entity_id = e.id
      left join loops l on l.entity_id = e.id
      left join mems m on m.entity_id = e.id
      where e.user_id = ${userId} and not e.is_self and e.kind in ('person', 'org', 'project', 'idea')
    )
    select id, kind, name, status, items_90d, last_seen, loops, memories, pinned, rn,
           -- Where a person or organisation writes from, so the model can tell a client from a stranger.
           (select coalesce(array_agg(distinct split_part(a.alias, '@', 2)), '{}') from entity_aliases a
            where a.entity_id = scored.id and a.alias like '%_@_%') as domains,
           (select coalesce(array_agg(t.name order by t.n desc, t.name), '{}') from (
              select te.name, count(*) as n
              from item_entities pi
              join item_entities ti on ti.context_item_id = pi.context_item_id and ti.role = 'topic' and ti.entity_id <> pi.entity_id
              join entities te on te.id = ti.entity_id
              where pi.entity_id = scored.id
              group by te.name order by n desc, te.name limit 3) t) as topics
    from scored
    where pinned
       or (kind = 'person' and items_90d >= ${PERSON_MIN_ITEMS} and rn <= ${PERSON_CARDS})
       or (kind = 'org' and items_90d >= ${ORG_MIN_ITEMS} and rn <= ${ORG_CARDS})
       or (kind in ('project', 'idea') and coalesce(status, 'active') <> 'done' and items_90d + loops + memories > 0 and rn <= ${ENTRIES})
    order by kind, rn
  `;
}

async function otherCounts(userId: string) {
  const [row] = await sql`
    select
      (select count(*)::int from context_items ci
       where ci.user_id = ${userId} and ci.kind = 'event' and ci.ts between now() and now() + interval '7 days'
         and ci.signals_at is not null and coalesce((ci.signals->>'sensitive')::real, 1) < ${SENSITIVE_ITEM_MIN}) as events,
      (select count(*)::int from suggestions
       where user_id = ${userId} and ts > now() - interval '7 days' and status not in ('accepted', 'dismissed')) as recommendations,
      (select count(*)::int from context_items
       where user_id = ${userId} and kind in ('email', 'message', 'chat') and ts > now() - interval '30 days' and ts <= now()) as messages,
      (select count(distinct ie.entity_id)::int from context_items ci
       join item_entities ie on ie.context_item_id = ci.id
       join entities e on e.id = ie.entity_id and e.kind <> 'person'
       where ci.user_id = ${userId} and ci.ts > now() - interval '30 days' and ci.ts <= now()
         and ci.triage is distinct from 'drop') as topics
  `;
  return row;
}

async function storedDashboard(userId: string) {
  const [row] = await sql`
    select spec, fingerprint, pinned, hidden, built_at,
           built_at is not null and built_at > now() - (${DASHBOARD_REBUILD_HOURS} || ' hours')::interval as fresh
    from dashboards where user_id = ${userId}
  `;
  return row as { spec: { panels?: string[] }; fingerprint: string | null; pinned: string[]; hidden: string[]; built_at: string | null; fresh: boolean } | undefined;
}

// What each panel is for, in the person's terms: the model judges the job a panel does for them.
const LOOP_VIEW: Record<string, string> = {
  replies_owed: "Messages waiting for the person's reply, so nobody is left hanging",
  promises: "Things the person promised someone and has not done yet",
  waiting_on: "Things the person asked of others that are still unanswered, to chase",
  going_quiet:
    "People they used to be in regular touch with (clients, candidates, colleagues, friends) who have gone quiet, to get back in touch before the relationship cools",
};

const ENTITY_VIEW: Record<string, string> = {
  person: "A card for one person: what they talk about, what is open between them, the latest messages",
  org: "A card for one organisation: what is open with it and the latest messages",
  project: "A card for one project: what is open on it, what earcue knows about it, the latest activity",
};

// Every panel with data behind it, in the fallback order, pinned ones whatever their data and hidden
// ones left out. Exported for the tests.
export function dashboardCandidates(
  loops: Record<string, any>[],
  entities: Record<string, any>[],
  counts: Record<string, any>,
  { pinned, hidden }: { pinned: readonly string[]; hidden: readonly string[] }
): Candidate[] {
  const out: Candidate[] = [];
  const offer = (key: string, count: number, floor: number, view: Record<string, unknown>) => {
    if (hidden.includes(key)) return;
    if (count >= floor || pinned.includes(key)) out.push({ key, count, view });
  };
  const loop = (kind: string) => loops.find((l) => l.kind === kind);
  const loopPanel = (type: keyof typeof LOOP_PANELS) => {
    const l = loop(LOOP_PANELS[type]);
    const n = Number(l?.n ?? 0);
    offer(type, n, 1, { panel: LOOP_VIEW[type], open: n, ...(l ? { people: Number(l.entities), oldest_days: daysSince(l.oldest) } : {}) });
  };

  const recs = Number(counts.recommendations ?? 0);
  offer("recommendations", recs, 1, { panel: "earcue's suggestions from this week of what to do next, still open", open: recs });
  loopPanel("replies_owed");
  const events = Number(counts.events ?? 0);
  offer("upcoming", events, 1, { panel: "Their meetings and events in the next 7 days, with when they last spoke to each person on them, to prepare", events });
  loopPanel("promises");
  loopPanel("waiting_on");

  const cards = entities.filter(
    (e) => e.pinned || e.kind === "person" || e.kind === "org" || (e.kind === "project" && Number(e.rn) <= PROJECT_CARDS)
  );
  for (const e of cards) {
    if (e.kind === "idea" && !e.pinned) continue;
    offer(`entity:${e.id}`, Number(e.items_90d), 0, {
      panel: ENTITY_VIEW[e.kind] ?? ENTITY_VIEW.project,
      kind: e.kind,
      name: e.name,
      ...(e.status ? { status: e.status } : {}),
      ...(e.domains?.length ? { writes_from: e.domains.slice(0, 3) } : {}),
      ...(e.topics?.length ? { topics: e.topics } : {}),
      items_90_days: Number(e.items_90d),
      last_seen_days: daysSince(e.last_seen),
      open_loops: Number(e.loops),
      memories: Number(e.memories),
    });
  }

  const projects = entities.filter((e) => e.kind === "project" || e.kind === "idea");
  const stalled = Number(loop("stale_project")?.n ?? 0) + Number(loop("parked_idea")?.n ?? 0);
  offer("projects", projects.length, PROJECTS_MIN, { panel: "All their projects and ideas in one list, and which ones have stalled", projects: projects.length, stalled });
  loopPanel("going_quiet");
  const messages = Number(counts.messages ?? 0);
  offer("inbox_pulse", messages, PULSE_MIN_ITEMS, { panel: "Statistics: how much mail and chat arrived this week, and how much of it mattered", messages_30_days: messages });
  const topics = Number(counts.topics ?? 0);
  offer("topics", topics, TOPICS_MIN, { panel: "Statistics: the organisations, projects and topics they talked about most this month", topics });
  return out;
}

// ---------- the decision ----------

export const DASHBOARD_QUESTIONS: readonly Question[] = [
  {
    key: "useful",
    kind: "probability",
    text:
      "Would the person look at this panel most working days, because it helps them do their work? Think about what their work " +
      "depends on (the profile): a recruiter lives on keeping candidates warm, a freelancer on clients, a founder on investors and " +
      "shipping. A panel with only one or two entries is worth it when those entries matter to that work; a card about someone " +
      "incidental to it, or a list that is only statistics, is not.",
  },
  { key: "central", kind: "score", scale: [0, 1], text: "How central it is to what they are working on right now: 1 the core of their work this week, 0 background." },
];

// The questions' texts are part of what the model reads, so a change to them bumps the version too.
export const DASHBOARD_PROMPT: Prompt = {
  version: "2",
  text:
    "You arrange one person's dashboard in earcue, which reads their mail, chats and calendar. Each candidate panel in the " +
    "untrusted block has a key `w`, what the `panel` shows, and its numbers; a card is about one person, organisation or project, " +
    "named in `name`. `today` is the person's date; `profile_static` and `profile_dynamic` say who they are and what they are " +
    "working on. Their work can be anything; judge what would help this person, not a typical office worker. Judge each panel " +
    `on its own. Questions: ${DASHBOARD_QUESTIONS.map((q) => q.key).join(", ")}.`,
};

// The build's subrequests after the session: the users row, five reads, the charge, the run row
// (insert, update), the ceiling read, the model call and its metering, and the upsert.
export const DASHBOARD_READ_SUBREQUESTS = 5;
export const DASHBOARD_BUILD_SUBREQUESTS = 1 + DASHBOARD_READ_SUBREQUESTS + 1 + 2 + 1 + MODEL_CALL_SUBREQUESTS + 1;

interface Built {
  panels: string[];
  filled: number;
  by: "decide" | "fallback" | "none";
}

async function decidePanels(
  user: { id: string; tz: string | null },
  candidates: Candidate[],
  pinned: string[],
  profile: Awaited<ReturnType<typeof profileFor>>
): Promise<{ built: Built; runId: string | null }> {
  const keys = candidates.map((c) => c.key);
  const ask = candidates.filter((c) => !pinned.includes(c.key));
  const run = new Run(user.id, "dashboard", DASHBOARD_PROMPT, env.MODEL_ANNOTATE);
  const about = ask.map((_, i) => `w${i + 1}`);
  try {
    const built = await run.track(async () => {
      const result = await decide({
        instruction: DASHBOARD_PROMPT.text,
        state: { panels: ask.map((c, i) => ({ w: about[i], ...c.view })) },
        trusted: { today: todayIn(user.tz), profile_static: profile?.static ?? [], profile_dynamic: profile?.dynamic ?? [] },
        questions: DASHBOARD_QUESTIONS,
        about,
        userId: user.id,
        run,
        deadlineMs: 20_000,
      });
      if (result.answers.size === 0) throw new InvalidOutput("dashboard: no panel answered");
      const scores = new Map<string, PanelScore>();
      for (const [w, a] of result.answers) {
        const c = ask[about.indexOf(w)];
        if (c) scores.set(c.key, { useful: Number(a.useful), central: Number(a.central) });
      }
      const picked = pickPanels(keys, scores, pinned);
      run.output = {
        candidates: keys.length,
        asked: ask.length,
        answered: scores.size,
        useful: [...scores.values()].filter((s) => s.useful >= 0.5).length,
        chosen: picked.panels,
        filled: picked.filled,
        // Per panel key, [useful, central]: numbers and keys only, like the rest of the run log.
        scores: Object.fromEntries([...scores].map(([k, v]) => [k, [v.useful, v.central]])),
        ...(result.dropped > 0 ? { range_dropped: result.dropped } : {}),
        ...(result.redacted > 0 ? { redacted: result.redacted } : {}),
      };
      run.settle(scores.size, result.dropped);
      return { ...picked, by: "decide" as const };
    });
    return { built, runId: run.id };
  } catch (err) {
    if (err instanceof SpendCeilingReached) throw err;
    logError("dashboard_decide_failed", err, { userId: user.id });
    return { built: { ...pickPanels(keys, null, pinned), by: "fallback" }, runId: run.id };
  }
}

// POST dashboard-build: rebuilds the page when its candidates changed or it is a day old. One
// `assist_calls` unit only when the model is asked (decision G4). Answers {built, panels}.
export async function handleDashboardBuild(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const [stored, profile, loops, entities, counts] = await Promise.all([
    storedDashboard(user.id),
    profileFor(user.id),
    loopCounts(user.id),
    entityRows(user.id),
    otherCounts(user.id),
  ]);
  const pinned = stored?.pinned ?? [];
  const hidden = stored?.hidden ?? [];
  const candidates = dashboardCandidates(loops, entities, counts, { pinned, hidden });
  const fingerprint = createHash("sha256").update(fingerprintText(candidates, pinned)).digest("hex").slice(0, 32);
  if (stored?.fresh && stored.fingerprint === fingerprint) return json({ built: false, panels: stored.spec.panels ?? [] });

  let built: Built;
  let runId: string | null = null;
  if (candidates.every((c) => pinned.includes(c.key))) {
    // Nothing to ask about: the pins, or an empty page.
    built = { ...pickPanels(candidates.map((c) => c.key), new Map(), pinned), filled: 0, by: "none" };
  } else {
    await consume(user, "assist_calls", 1);
    ({ built, runId } = await decidePanels(user, candidates, pinned, profile));
  }

  const spec = JSON.stringify({ panels: built.panels, by: built.by, filled: built.filled });
  await sql`
    insert into dashboards (user_id, spec, fingerprint, run_id, built_at, updated_at)
    values (${user.id}, ${spec}::jsonb, ${fingerprint}, ${runId}, now(), now())
    on conflict (user_id) do update set spec = excluded.spec, fingerprint = excluded.fingerprint, run_id = excluded.run_id,
      built_at = excluded.built_at, updated_at = excluded.updated_at
  `;
  return json({ built: true, panels: built.panels });
}

// ---------- reading the page ----------

// A Worker invocation holds at most six open connections.
const READ_BATCH = 6;

async function loopPanel(userId: string, type: keyof typeof LOOP_PANELS): Promise<PanelData> {
  const rows = await openLoops(userId, { kind: LOOP_PANELS[type], limit: ENTRIES, bodyChars: 0 });
  return {
    type,
    entries: rows.map((l) => ({
      id: l.id,
      who: l.entity?.name ?? l.item?.from ?? null,
      title: l.item?.title || l.memory?.text || l.entity?.name || "",
      provider: l.item?.provider ?? null,
      ts: l.item?.ts || l.detectedAt || null,
      usualGapDays: l.usualGapDays,
    })),
  };
}

async function recommendationsPanel(userId: string): Promise<PanelData> {
  const rows = await sql`
    select client_id, kind, title, urgency, ts from suggestions
    where user_id = ${userId} and ts > now() - interval '7 days' and status not in ('accepted', 'dismissed')
    order by case urgency when 'high' then 0 when 'medium' then 1 else 2 end, ts desc
    limit 5
  `;
  return { type: "recommendations", entries: rows.map((r) => ({ clientId: r.client_id, kind: r.kind, title: r.title, urgency: r.urgency, ts: iso(r.ts)! })) };
}

async function upcomingPanel(userId: string): Promise<PanelData> {
  const rows = await eventsAhead(userId, { fromHours: 0, hours: 7 * 24, limit: ENTRIES });
  return {
    type: "upcoming",
    entries: rows.map((e) => ({
      id: String(e.id),
      title: e.title ?? "",
      ts: iso(e.ts)!,
      location: e.location ?? null,
      people: ((e.people as { name: string; last_contact: string | null }[]) ?? []).map((p) => ({ name: p.name, lastContact: iso(p.last_contact) })),
    })),
  };
}

async function projectsPanel(userId: string): Promise<PanelData> {
  const rows = await sql`
    select e.id, e.kind, e.name, e.status,
           (select max(ci.ts) from item_entities ie join context_items ci on ci.id = ie.context_item_id
            where ie.entity_id = e.id and ci.ts <= now()) as last_activity,
           (select count(*)::int from open_loops l
            where l.entity_id = e.id and l.status = 'open' and l.kind not in ('stale_project', 'parked_idea')) as open_loops,
           exists (select 1 from open_loops l
                   where l.entity_id = e.id and l.status = 'open' and l.kind in ('stale_project', 'parked_idea')) as stalled
    from entities e
    where e.user_id = ${userId} and e.kind in ('project', 'idea') and coalesce(e.status, 'active') <> 'done'
    order by (e.kind = 'project') desc, last_activity desc nulls last, e.id
    limit ${ENTRIES}
  `;
  return {
    type: "projects",
    entries: rows.map((r) => ({
      id: String(r.id),
      kind: r.kind,
      name: r.name,
      status: r.status ?? null,
      lastActivity: iso(r.last_activity),
      openLoops: Number(r.open_loops),
      stalled: Boolean(r.stalled),
    })),
  };
}

// One person, organisation or project in one query: activity, the topics on its items, its open
// loops, its strongest non-sensitive memories and its latest items (loops and items under the
// proactive rule; activity and items without what annotation called noise).
async function entityPanel(userId: string, entityId: string): Promise<PanelData | null> {
  const [r] = await sql`
    select e.id, e.kind, e.name, e.status,
      (select count(distinct ci.id)::int from item_entities ie join context_items ci on ci.id = ie.context_item_id
       where ie.entity_id = e.id and ci.ts > now() - interval '90 days' and ci.ts <= now() and ci.triage is distinct from 'drop') as items_90d,
      (select max(ci.ts) from item_entities ie join context_items ci on ci.id = ie.context_item_id
       where ie.entity_id = e.id and ci.ts <= now()) as last_contact,
      (select coalesce(jsonb_agg(t.name order by t.n desc, t.name), '[]'::jsonb) from (
         select te.name, count(*) as n
         from item_entities pi
         join item_entities ti on ti.context_item_id = pi.context_item_id and ti.role = 'topic' and ti.entity_id <> e.id
         join entities te on te.id = ti.entity_id
         where pi.entity_id = e.id
         group by te.name order by n desc, te.name limit 3) t) as topics,
      (select coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'title', x.title, 'ts', x.ts) order by x.score desc, x.id desc), '[]'::jsonb) from (
         select l.id, l.kind, l.score, coalesce(ci.title, '') as title, ci.ts
         from open_loops l left join context_items ci on ci.id = l.context_item_id
         where l.entity_id = e.id and l.status = 'open'
           and (ci.id is null or ci.kind <> all(${ANNOTATE_KINDS}::text[])
                or (ci.signals_at is not null and coalesce((ci.signals->>'sensitive')::real, 1) < ${SENSITIVE_ITEM_MIN}))
         order by l.score desc, l.id desc limit 4) x) as loops,
      (select coalesce(jsonb_agg(x.text order by x.strength desc), '[]'::jsonb) from (
         select m.text, memory_strength(m.importance, m.kind, m.last_seen_at) as strength
         from memories m
         where m.entity_id = e.id and m.forgotten_at is null and m.superseded_by is null and not m.sensitive
           and (m.expires_at is null or m.expires_at > now())
         order by strength desc limit 3) x) as memories,
      (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'provider', x.provider, 'kind', x.kind, 'title', x.title, 'from', x.sender, 'ts', x.ts) order by x.ts desc), '[]'::jsonb) from (
         select ci.id, ci.provider, ci.kind, coalesce(ci.title, '') as title, ci.meta->>'from' as sender, ci.ts
         from context_items ci
         where ci.user_id = e.user_id and ci.ts <= now() and ci.triage is distinct from 'drop'
           and exists (select 1 from item_entities ie where ie.context_item_id = ci.id and ie.entity_id = e.id)
           and (ci.kind <> all(${ANNOTATE_KINDS}::text[])
                or (ci.signals_at is not null and coalesce((ci.signals->>'sensitive')::real, 1) < ${SENSITIVE_ITEM_MIN}))
         order by ci.ts desc limit 3) x) as latest
    from entities e
    where e.id = ${entityId} and e.user_id = ${userId} and not e.is_self
  `;
  if (!r) return null;
  const card: EntityCard = {
    id: String(r.id),
    kind: r.kind,
    name: r.name,
    status: r.status ?? null,
    items90d: Number(r.items_90d),
    lastContact: iso(r.last_contact),
    topics: r.topics ?? [],
    loops: (r.loops ?? []).map((l: { kind: string; title: string; ts: string | null }) => ({ kind: l.kind, title: l.title, ts: iso(l.ts) })),
    memories: r.memories ?? [],
    latest: (r.latest ?? []).map((i: { id: number; provider: string; kind: string; title: string; from: string | null; ts: string }) => ({
      id: String(i.id),
      provider: i.provider,
      kind: i.kind,
      title: i.title,
      from: i.from ?? null,
      ts: iso(i.ts)!,
    })),
  };
  return { type: "entity", card };
}

async function pulsePanel(userId: string): Promise<PanelData> {
  const rows = await sql`
    select ci.provider, count(*)::int as items,
           (count(*) filter (where ci.triage = 'key'))::int as key,
           (count(*) filter (where ci.triage = 'keep'))::int as keep,
           (count(*) filter (where ci.triage = 'drop'))::int as dropped,
           (count(*) filter (where ci.signals_at is null))::int as pending,
           (select count(*)::int from open_loops l join context_items c2 on c2.id = l.context_item_id
            where l.user_id = ${userId} and l.status = 'open' and l.kind = 'reply_owed' and c2.provider = ci.provider) as owed
    from context_items ci
    where ci.user_id = ${userId} and ci.kind in ('email', 'message', 'chat') and ci.ts > now() - interval '7 days' and ci.ts <= now()
    group by ci.provider
    order by items desc, ci.provider
    limit 6
  `;
  return {
    type: "inbox_pulse",
    entries: rows.map((r) => ({
      provider: r.provider,
      items: Number(r.items),
      key: Number(r.key),
      keep: Number(r.keep),
      dropped: Number(r.dropped),
      pending: Number(r.pending),
      owed: Number(r.owed),
    })),
  };
}

async function topicsPanel(userId: string): Promise<PanelData> {
  const rows = await sql`
    select e.id, e.kind, e.name, count(distinct ci.id)::int as items
    from context_items ci
    join item_entities ie on ie.context_item_id = ci.id
    join entities e on e.id = ie.entity_id and e.kind <> 'person'
    where ci.user_id = ${userId} and ci.ts > now() - interval '30 days' and ci.ts <= now() and ci.triage is distinct from 'drop'
    group by e.id, e.kind, e.name
    order by items desc, e.name
    limit ${ENTRIES}
  `;
  return { type: "topics", entries: rows.map((r) => ({ id: String(r.id), kind: r.kind, name: r.name, items: Number(r.items) })) };
}

// Each panel is one query. Null when a panel's entity is gone.
export function readPanel(userId: string, key: string): Promise<PanelData | null> {
  const parsed = parsePanelKey(key);
  if (!parsed) return Promise.resolve(null);
  switch (parsed.type) {
    case "recommendations":
      return recommendationsPanel(userId);
    case "replies_owed":
    case "promises":
    case "waiting_on":
    case "going_quiet":
      return loopPanel(userId, parsed.type);
    case "upcoming":
      return upcomingPanel(userId);
    case "projects":
      return projectsPanel(userId);
    case "entity":
      return entityPanel(userId, parsed.entityId!);
    case "inbox_pulse":
      return pulsePanel(userId);
    case "topics":
      return topicsPanel(userId);
  }
}

// GET dashboard: the stored page, each panel read now, so a reply sent since the build is already
// gone from it. A read, like GET suggestions: the session only.
export async function handleDashboard(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const [row] = await sql`select spec, pinned, hidden, built_at from dashboards where user_id = ${user.id}`;
  const keys: string[] = row?.spec?.panels ?? [];
  const data: (PanelData | null)[] = [];
  for (let i = 0; i < keys.length; i += READ_BATCH) {
    data.push(...(await Promise.all(keys.slice(i, i + READ_BATCH).map((k) => readPanel(user.id, k)))));
  }
  const pinned: string[] = row?.pinned ?? [];
  const panels: Panel[] = [];
  keys.forEach((key, i) => {
    if (data[i]) panels.push({ key, pinned: pinned.includes(key), ...data[i]! });
  });
  const out: DashboardOut = { panels, builtAt: iso(row?.built_at), by: row?.spec?.by ?? null, hidden: row?.hidden ?? [] };
  return json(out);
}

// ---------- pin and hide ----------

const ACTIONS: readonly PanelAction[] = ["pin", "hide", "reset"];

// POST dashboard-panel {key, action}: pin, hide or reset one panel. The page changes at once; the
// next build keeps it that way. The session only, like forget.
export async function handleDashboardPanel(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const body = await readJson(request);
  const key = parsePanelKey(body.key) ? String(body.key) : null;
  const action = ACTIONS.find((a) => a === body.action);
  if (!key || !action) return json({ error: "key and action required" }, 400);

  const [row] = await sql`select spec, pinned, hidden from dashboards where user_id = ${user.id}`;
  const spec = row?.spec ?? { panels: [] };
  const next = applyPanelAction({ panels: spec.panels ?? [], pinned: row?.pinned ?? [], hidden: row?.hidden ?? [] }, key, action);
  const nextSpec = JSON.stringify({ ...spec, panels: next.panels });
  await sql`
    insert into dashboards (user_id, spec, pinned, hidden, updated_at)
    values (${user.id}, ${nextSpec}::jsonb, ${next.pinned}::text[], ${next.hidden}::text[], now())
    on conflict (user_id) do update set spec = excluded.spec, pinned = excluded.pinned, hidden = excluded.hidden, updated_at = excluded.updated_at
  `;
  return json({ panels: next.panels, pinned: next.pinned, hidden: next.hidden });
}
