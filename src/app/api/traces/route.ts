import { requireUser, touchTz } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { json, query, readJson, withErrors } from "@/lib/server/respond";
import type { TraceRow } from "@/lib/shared/types";

// The raw transcript timeline: POST batches captured rows in, GET serves the day view, ?q= search and
// the ?from=&to= calendar heatmap.

export const POST = withErrors(async (request: Request) => {
  const user = await requireUser(request.headers);
  const { tz, rows } = await readJson(request);
  await touchTz(user.id, tz);
  if (!Array.isArray(rows)) return json({ error: "rows required" }, 400);
  if (rows.length > 500) return json({ error: "too many rows" }, 400);
  if ((rows as TraceRow[]).some((r) => typeof r.text === "string" && r.text.length > 10_000)) {
    return json({ error: "row text too long" }, 400);
  }

  if (rows.length === 0) return json({ inserted: 0 });

  const list = rows as TraceRow[];
  const userIds = list.map(() => user.id);
  const tsList = list.map((r) => r.ts);
  const localDays = list.map((r) => r.localDay);
  const kinds = list.map((r) => r.kind);
  const sources = list.map((r) => r.source || null);
  const speakers = list.map((r) => r.speaker || null);
  const texts = list.map((r) => r.text);
  const metas = list.map((r) => JSON.stringify(r.meta || {}));
  const clientIds = list.map((r) => r.clientId);

  const result = await sql`
    insert into traces (user_id, ts, local_day, kind, source, speaker, text, meta, client_id)
    select * from unnest(
      ${userIds}::uuid[], ${tsList}::timestamptz[], ${localDays}::date[], ${kinds}::text[],
      ${sources}::text[], ${speakers}::text[], ${texts}::text[], ${metas}::jsonb[], ${clientIds}::text[]
    )
    on conflict (user_id, client_id) do nothing
    returning id
  `;
  return json({ inserted: result.length });
});

export const GET = withErrors(async (request: Request) => {
  const user = await requireUser(request.headers);
  const params = query(request);
  const day = params.get("day");
  const from = params.get("from");
  const to = params.get("to");
  const q = params.get("q");

  if (q) {
    const rows = await sql`
      select ts, to_char(local_day, 'YYYY-MM-DD') as local_day, kind, source, speaker, text, meta, client_id
      from traces
      where user_id = ${user.id} and text_tsv @@ plainto_tsquery('english', ${q})
      order by ts desc
      limit 100
    `;
    return json({ rows });
  }

  if (from && to) {
    const rows = await sql`
      select to_char(t.local_day, 'YYYY-MM-DD') as day, count(*)::int as trace_count, dr.status as review_status
      from traces t
      left join day_reviews dr on dr.user_id = t.user_id and dr.day = t.local_day
      where t.user_id = ${user.id} and t.local_day >= ${from} and t.local_day <= ${to}
      group by t.local_day, dr.status
      order by t.local_day desc
    `;
    return json({ days: rows });
  }

  if (!day) return json({ error: "day required" }, 400);
  const rows = await sql`
    select ts, to_char(local_day, 'YYYY-MM-DD') as local_day, kind, source, speaker, text, meta, client_id
    from traces
    where user_id = ${user.id} and local_day = ${day}
    order by ts asc
  `;
  const reviewRows = await sql`
    select to_char(day, 'YYYY-MM-DD') as day, status, payload, error
    from day_reviews
    where user_id = ${user.id} and day = ${day}
  `;
  return json({ rows, review: reviewRows[0] || null });
});
