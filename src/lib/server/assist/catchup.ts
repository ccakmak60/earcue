import "server-only";
import { requireAuthed } from "../auth";
import { sql } from "../db";
import { annotationsPending } from "../annotate";
import { distillBacklog, embedDue } from "../knowledge";
import { refreshOpenLoops } from "../open-loops";
import { logError } from "../log";
import { json } from "../respond";

// What background work is outstanding for this one user. Inference-free: the client turns each
// entry into an ordinary POST (/api/review, /api/assist/annotate, /api/assist/distill), so quota and
// entitlement are charged by those endpoints, not here. Its one write is the open-loop refresh
// (open-loops.ts, one SQL call): every catch-up reads this plan first, and again after annotating,
// so loops are resolved and detected on the latest signals with no scheduled job, and time-based
// ones (a silence, a stale project, expiry) move even when nothing new arrived. Replaces the hourly sweep's
// ?plan=1. `profileDue` is served by the same distill request, which rebuilds a stale profile. The
// client annotates before it distills, and asks again after annotating, because annotation is what
// makes new items ready: `distillDue` counts only items distill would take now.
export async function handleCatchup(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });
  const tz = user.tz || "UTC"; // User.tz is `string` (auth.ts:9-14; rows insert with 'UTC'), the guard only covers an empty column

  // Before the batch below, which already holds six connections. A failure leaves the loops as they
  // were until the next catch-up; the plan itself still answers.
  let loops: Awaited<ReturnType<typeof refreshOpenLoops>> | null = null;
  try {
    loops = await refreshOpenLoops(user.id);
  } catch (err) {
    logError("open_loops_refresh_failed", err, { userId: user.id });
  }

  // A day is reviewable once it is over in the user's own zone — no clock-hour gate, because
  // nothing fires on a clock any more. `in_progress` inside ten minutes is excluded so a review
  // another tab just started is not paid for twice (runReview marks the row before the model call).
  const [days, [traces], [profile], backlog, embedding, annotations] = await Promise.all([
    sql`
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
    `,
    sql`
      select exists (
        select 1 from traces t
        left join user_profile p on p.user_id = t.user_id
        where t.user_id = ${user.id} and t.id > coalesce(p.trace_cursor, 0)
      ) as due
    `,
    // A forget or a correction cleared built_at. Due only while there is something to rebuild from
    // or to clear: a new account's empty profile row is not stale.
    sql`
      select exists (
        select 1 from user_profile p
        where p.user_id = ${user.id} and p.built_at is null
          and (p.summary <> '' or p.static_facts <> '[]'::jsonb or p.dynamic_facts <> '[]'::jsonb
               or exists (select 1 from memories m where m.user_id = p.user_id and m.forgotten_at is null))
      ) as due
    `,
    distillBacklog(user.id),
    embedDue(user.id),
    annotationsPending(user.id),
  ]);

  return json({
    reviewDays: days.map((d) => d.day),
    distillDue: backlog.ready > 0 || Boolean(traces.due) || embedding,
    profileDue: Boolean(profile.due),
    annotateDue: annotations > 0,
    loops,
  });
}
