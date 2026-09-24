import "server-only";
import { requireAuthed } from "../auth";
import { sql } from "../db";
import { ANNOTATE_KINDS, ANNOTATE_MAX_ATTEMPTS } from "../annotate";
import { EMBED_KINDS } from "../knowledge";
import { json } from "../respond";

// What background work is outstanding for this one user. Read-only and inference-free: the client
// turns each entry into an ordinary POST (/api/review, /api/assist/distill), so quota and
// entitlement are charged by those endpoints, not here. Replaces the hourly sweep's ?plan=1.
// `profileDue` is served by the same distill request, which rebuilds a stale profile, and so is
// `annotateDue`.
export async function handleCatchup(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });
  const tz = user.tz || "UTC"; // User.tz is `string` (auth.ts:9-14; rows insert with 'UTC'), the guard only covers an empty column

  // A day is reviewable once it is over in the user's own zone — no clock-hour gate, because
  // nothing fires on a clock any more. `in_progress` inside ten minutes is excluded so a review
  // another tab just started is not paid for twice (runReview marks the row before the model call).
  const days = (await sql`
    select to_char(t.local_day, 'YYYY-MM-DD') as day
    from traces t
    where t.user_id = ${user.id}
      and t.local_day < (now() at time zone ${tz})::date
      and not exists (
        select 1 from day_reviews dr
        where dr.user_id = t.user_id and dr.day = t.local_day
          and (dr.status = 'completed' or (dr.status = 'in_progress' and dr.updated_at > now() - interval '10 minutes'))
      )
    group by t.local_day
    order by t.local_day desc
    limit 3
  `) as { day: string }[];

  const [pending] = await sql`
    select
      exists (
        select 1 from context_items ci
        left join user_profile p on p.user_id = ci.user_id
        where ci.user_id = ${user.id} and ci.id > coalesce(p.distill_cursor, 0)
      ) or exists (
        select 1 from traces t
        left join user_profile p on p.user_id = t.user_id
        where t.user_id = ${user.id} and t.id > coalesce(p.trace_cursor, 0)
      ) or exists (
        select 1 from context_items
        where user_id = ${user.id} and embedding is null and kind = any(${EMBED_KINDS}::text[])
          and (title || body) ~ '\\S'
      ) as due,
      exists (
        select 1 from context_items
        where user_id = ${user.id} and signals_at is null and kind = any(${ANNOTATE_KINDS}::text[])
          and coalesce((signals->>'attempts')::int, 0) < ${ANNOTATE_MAX_ATTEMPTS}
          and (title || body) ~ '\\S'
      ) as annotate_due
  `;

  // A forget or a correction cleared built_at. Due only while there is something to rebuild from or
  // to clear: a new account's empty profile row is not stale.
  const [profile] = await sql`
    select exists (
      select 1 from user_profile p
      where p.user_id = ${user.id} and p.built_at is null
        and (p.summary <> '' or p.static_facts <> '[]'::jsonb or p.dynamic_facts <> '[]'::jsonb
             or exists (select 1 from memories m where m.user_id = p.user_id and m.forgotten_at is null))
    ) as due
  `;

  // `annotateDue` is reported, not acted on: annotation runs inside the distill passes that happen
  // anyway (in shadow, it must not add requests or spend a `distills` unit of its own).
  return json({
    reviewDays: days.map((d) => d.day),
    distillDue: Boolean(pending.due),
    profileDue: Boolean(profile.due),
    annotateDue: Boolean(pending.annotate_due),
  });
}
