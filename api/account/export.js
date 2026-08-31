import { sql } from "../_lib/db.js";
import { requireUser, Unauthorized } from "../_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof Unauthorized) return res.status(401).json({ error: "unauthorized" });
    throw e;
  }

  const [profile] = await sql`select id, tz, plan, plan_status, current_period_end, created_at from users where id = ${user.id}`;
  const traces = await sql`
    select ts, local_day, kind, source, speaker, text, meta, client_id
    from traces where user_id = ${user.id} order by ts asc
  `;
  const dayReviews = await sql`
    select day, status, payload, error, updated_at
    from day_reviews where user_id = ${user.id} order by day asc
  `;

  res.setHeader("content-disposition", `attachment; filename="earcue-export-${user.id}.json"`);
  res.status(200).json({ profile, traces, dayReviews });
}
