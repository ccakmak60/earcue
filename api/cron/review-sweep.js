import { sql } from "../_lib/db.js";
import { startReview } from "../review.js";

export default async function handler(req, res) {
  const ua = req.headers["user-agent"] || "";
  if (!ua.startsWith("vercel-cron/")) return res.status(403).end();

  const candidates = await sql`
    select distinct t.user_id, t.local_day, u.tz
    from traces t
    join users u on u.id = t.user_id
    where t.local_day < (now() at time zone u.tz)::date
      and not exists (
        select 1 from day_reviews dr
        where dr.user_id = t.user_id and dr.day = t.local_day and dr.status = 'completed'
      )
    limit 20
  `;

  const started = [];
  for (const c of candidates) {
    try {
      await startReview(c.user_id, c.tz, c.local_day);
      started.push({ userId: c.user_id, day: c.local_day });
    } catch (err) {
      console.error("review-sweep failed for", c.user_id, c.local_day, err);
    }
  }

  res.status(200).json({ started: started.length });
}
