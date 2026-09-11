import { sql } from "../_lib/db.js";
import { runReview } from "../review.js";
import { consume } from "../_lib/quota.js";
import { runDistillPass, forgetStaleMemories } from "../_lib/knowledge.js";
import { env } from "../_lib/env.js";
import { log, logError } from "../_lib/log.js";

// Hobby-plan contingency: this runs once a day (see vercel.json), not hourly.
// Every user's day review generation lands in this single fixed-UTC pass instead
// of at each user's local 22:00, so completion time drifts relative to each
// user's evening. Upgrading to Vercel Pro and scheduling this hourly (checking
// each user's local time) removes the drift without changing anything else here.
//
// The knowledge-base distillation sweep (formerly its own cron/knowledge-sweep.js)
// also runs here, after the review work, on the remainder of the same budget \u2014
// a second daily cron would be a second Serverless Function, and the Hobby plan
// caps a deployment at 12 of those.

async function runKnowledgeSweep(deadline, limit) {
  const { forgotten } = await forgetStaleMemories();

  const candidates = await sql`
    select u.id, u.tz from users u
    left join user_profile p on p.user_id = u.id
    where exists (
        select 1 from context_items ci where ci.user_id = u.id and ci.id > coalesce(p.distill_cursor, 0)
      ) or exists (
        select 1 from traces t where t.user_id = u.id and t.id > coalesce(p.trace_cursor, 0)
      )
    limit ${limit}
  `;

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
      const user = { id: c.id, tz: c.tz, plan: "pro" };
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

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${env.CRON_SECRET}`) return res.status(401).end();

  const start = Date.now();
  const totalBudget = Number(env.SWEEP_BUDGET_MS);
  const limit = Number(env.SWEEP_LIMIT);
  // Review generation gets the first ~70% of the budget, knowledge distillation
  // gets whatever remains (down to zero on a busy night, which just truncates it).
  const reviewDeadline = start + totalBudget * 0.7;
  const overallDeadline = start + totalBudget;

  const candidates = await sql`
    select distinct t.user_id, t.local_day, u.tz
    from traces t
    join users u on u.id = t.user_id
    where t.local_day < (now() at time zone u.tz)::date
      and not exists (
        select 1 from day_reviews dr
        where dr.user_id = t.user_id and dr.day = t.local_day and dr.status = 'completed'
      )
    limit ${limit}
  `;

  const started = [];
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
  res.status(200).json({ started: started.length, knowledge, truncated });
}
