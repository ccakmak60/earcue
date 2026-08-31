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
    if (rows.length > 500) return res.status(400).json({ error: "too many rows" });
    if (rows.some((r) => typeof r.text === "string" && r.text.length > 10_000)) {
      return res.status(400).json({ error: "row text too long" });
    }

    if (rows.length === 0) return res.status(200).json({ inserted: 0 });

    const userIds = rows.map(() => user.id);
    const tsList = rows.map((r) => r.ts);
    const localDays = rows.map((r) => r.localDay);
    const kinds = rows.map((r) => r.kind);
    const sources = rows.map((r) => r.source || null);
    const speakers = rows.map((r) => r.speaker || null);
    const texts = rows.map((r) => r.text);
    const metas = rows.map((r) => JSON.stringify(r.meta || {}));
    const clientIds = rows.map((r) => r.clientId);

    const result = await sql`
      insert into traces (user_id, ts, local_day, kind, source, speaker, text, meta, client_id)
      select * from unnest(
        ${userIds}::uuid[], ${tsList}::timestamptz[], ${localDays}::date[], ${kinds}::text[],
        ${sources}::text[], ${speakers}::text[], ${texts}::text[], ${metas}::jsonb[], ${clientIds}::text[]
      )
      on conflict (user_id, client_id) do nothing
      returning id
    `;
    const inserted = result.length;
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
