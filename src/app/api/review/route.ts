import { requireUser } from "@/lib/server/auth";
import { sql } from "@/lib/server/db";
import { assertEntitled } from "@/lib/server/entitlement";
import { consume } from "@/lib/server/quota";
import { json, query, readJson, withErrors } from "@/lib/server/respond";
import { runReview } from "@/lib/server/review";

export const POST = withErrors(async (request: Request) => {
  const user = await requireUser(request.headers);
  const { day } = await readJson(request);
  if (!day) return json({ error: "day required" }, 400);

  const existing = await sql`select status, payload, error from day_reviews where user_id = ${user.id} and day = ${day}`;
  if (existing.length > 0 && existing[0].status === "completed") {
    return json({ status: "completed", payload: existing[0].payload });
  }

  assertEntitled(user);
  await consume(user, "reviews", 1);

  return json(await runReview(user.id, user.tz, day));
});

export const GET = withErrors(async (request: Request) => {
  const user = await requireUser(request.headers);
  const day = query(request).get("day");
  if (!day) return json({ error: "day required" }, 400);

  const rows = await sql`select status, payload, error, updated_at from day_reviews where user_id = ${user.id} and day = ${day}`;
  if (rows.length === 0) return json({ status: "none" });

  const row = rows[0];
  if (row.status === "in_progress" && Date.now() - new Date(row.updated_at).getTime() > 90000) {
    const error = "generation timed out";
    await sql`update day_reviews set status = 'failed', error = ${error}, updated_at = now() where user_id = ${user.id} and day = ${day}`;
    return json({ status: "failed", error });
  }

  return json({ status: row.status, payload: row.payload, error: row.error });
});
