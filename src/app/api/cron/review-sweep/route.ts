import { sql } from "@/lib/server/db";
import { env } from "@/lib/server/env";
import { forgetStaleMemories, runDistillPass } from "@/lib/server/knowledge";
import { log, logError } from "@/lib/server/log";
import { effectivePlan } from "@/lib/server/plans";
import { consume } from "@/lib/server/quota";
import { empty, json } from "@/lib/server/respond";
import { runReview } from "@/lib/server/review";

// Fired by the Cloudflare Cron Trigger in infra/sweep-cron. Two shapes:
//
//   ?plan=1  — return the work without doing any of it. infra/sweep-cron turns each candidate into
//              one earcue-sweep message, and the consumer calls ./run for it. One slow user then
//              costs one message its own retry instead of starving everyone behind it, and a
//              failure is a queue retry rather than a silent `truncated: true`.
//   (none)   — do everything inline on one budget. Still the local/manual path (`curl`), and what
//              runs if the queue is ever unavailable, so it stays exactly as it was.
//
// The hourly trigger plus `local_hour` below is what fixes the review timing: reviews are generated
// after each user's own evening rather than all at one fixed UTC hour.

async function runKnowledgeSweep(deadline: number, limit: number) {
  const { forgotten } = await forgetStaleMemories();

  const candidates = await distillCandidates(limit);

  let created = 0;
  let updated = 0;
  let derived = 0;
  let episodes = 0;
  let truncated = false;

  for (const c of candidates) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    try {
      const user = { id: c.id, tz: c.tz, plan: effectivePlan(c.plan), unlimited: c.unlimited };
      await consume(user, "distills", 1);
      const result = await runDistillPass(user, Math.min(deadline, Date.now() + 45000));
      created += result.created;
      updated += result.updated;
      derived += result.derived;
      episodes += result.episodes;
    } catch (err) {
      logError("knowledge_sweep_failed", err, { userId: c.id });
    }
  }

  return { users: candidates.length, created, updated, derived, episodes, forgotten, truncated };
}

// A day is reviewable once it is over in the user's own zone and the local clock has passed
// REVIEW_LOCAL_HOUR, so an hourly trigger reaches each user just after their evening.
//
// `in_progress` inside the last ten minutes is excluded too: runReview marks the row before it calls
// the model, so without this an hourly trigger landing on a still-running review re-plans that user
// and pays for a second completion. Ten minutes is well past the route's own 45s model deadline, so
// a genuinely stuck row still comes back as a candidate on the next hour.
async function reviewCandidates(limit: number) {
  return (await sql`
    select distinct t.user_id, t.local_day, u.tz
    from traces t
    join users u on u.id = t.user_id
    where t.local_day < (now() at time zone u.tz)::date
      and extract(hour from (now() at time zone u.tz)) >= ${Number(env.REVIEW_LOCAL_HOUR)}
      and not exists (
        select 1 from day_reviews dr
        where dr.user_id = t.user_id and dr.day = t.local_day
          and (dr.status = 'completed' or (dr.status = 'in_progress' and dr.updated_at > now() - interval '10 minutes'))
      )
    limit ${limit}
  `) as { user_id: string; local_day: string; tz: string }[];
}

async function distillCandidates(limit: number) {
  return (await sql`
    select u.id, u.tz, u.plan, u.unlimited from users u
    left join user_profile p on p.user_id = u.id
    where exists (
        select 1 from context_items ci where ci.user_id = u.id and ci.id > coalesce(p.distill_cursor, 0)
      ) or exists (
        select 1 from traces t where t.user_id = u.id and t.id > coalesce(p.trace_cursor, 0)
      )
    limit ${limit}
  `) as { id: string; tz: string; plan: string | null; unlimited: boolean | null }[];
}

async function handler(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${env.CRON_SECRET}`) return empty(401);

  const limitParam = Number(env.SWEEP_LIMIT);
  if (new URL(request.url).searchParams.get("plan") === "1") {
    const [reviews, distills] = await Promise.all([reviewCandidates(limitParam), distillCandidates(limitParam)]);
    return json({
      reviews: reviews.map((c) => ({ kind: "review", userId: c.user_id, tz: c.tz, day: c.local_day })),
      distills: distills.map((c) => ({ kind: "distill", userId: c.id, tz: c.tz, plan: c.plan, unlimited: c.unlimited })),
    });
  }

  const start = Date.now();
  const totalBudget = Number(env.SWEEP_BUDGET_MS);
  const limit = Number(env.SWEEP_LIMIT);
  // Review generation gets the first ~70% of the budget, knowledge distillation
  // gets whatever remains (down to zero on a busy night, which just truncates it).
  const reviewDeadline = start + totalBudget * 0.7;
  const overallDeadline = start + totalBudget;

  const candidates = await reviewCandidates(limit);

  const started: { userId: string; day: string }[] = [];
  let candidatesTruncated = false;
  for (const c of candidates) {
    if (Date.now() > reviewDeadline) {
      candidatesTruncated = true;
      break;
    }
    try {
      const result = await runReview(c.user_id, c.tz, c.local_day);
      if (result.status === "completed") {
        started.push({ userId: c.user_id, day: c.local_day });
      } else {
        logError("review_sweep_failed", new Error(result.error || "review failed"), { userId: c.user_id, day: c.local_day });
      }
    } catch (err) {
      logError("review_sweep_failed", err, { userId: c.user_id, day: c.local_day });
    }
  }

  const knowledge = await runKnowledgeSweep(overallDeadline, limit);

  const truncated = candidatesTruncated || knowledge.truncated;
  log("review_sweep_done", { started: started.length, knowledge, truncated });
  return json({ started: started.length, knowledge, truncated });
}

// The Cloudflare Cron Trigger worker sends GET; the legacy function accepted any method, so manual POST runs keep working.
export const GET = handler;
export const POST = handler;
