import { sql } from "./_lib/db.js";
import { requireUser, touchTz, Unauthorized } from "./_lib/auth.js";

export default async function handler(req, res) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof Unauthorized) return res.status(401).json({ error: "unauthorized" });
    throw e;
  }

  if (req.method === "POST") {
    const { tz, rows } = req.body || {};
    await touchTz(user.id, tz);
    if (!Array.isArray(rows)) return res.status(400).json({ error: "rows required" });

    let inserted = 0;
    for (const r of rows) {
      const result = await sql`
        insert into traces (user_id, ts, local_day, kind, source, speaker, text, meta, client_id)
        values (${user.id}, ${r.ts}, ${r.localDay}, ${r.kind}, ${r.source || null}, ${r.speaker || null}, ${r.text}, ${r.meta || {}}, ${r.clientId})
        on conflict (user_id, client_id) do nothing
        returning id
      `;
      if (result.length > 0) inserted++;
    }
    return res.status(200).json({ inserted });
  }

  if (req.method === "GET") {
    const day = req.query.day;
    if (!day) return res.status(400).json({ error: "day required" });
    const rows = await sql`
      select ts, local_day, kind, source, speaker, text, meta, client_id
      from traces
      where user_id = ${user.id} and local_day = ${day}
      order by ts asc
    `;
    const reviewRows = await sql`
      select day, status, payload, error
      from day_reviews
      where user_id = ${user.id} and day = ${day}
    `;
    return res.status(200).json({ rows, review: reviewRows[0] || null });
  }

  res.status(405).end();
}
