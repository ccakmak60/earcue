import { fromNodeHeaders } from "better-auth/node";
import { Polar } from "@polar-sh/sdk";
import { sql } from "../_lib/db.js";
import { requireUser, Unauthorized } from "../_lib/auth.js";
import { auth } from "../_lib/auth-server.js";

// Single serverless function serving both /api/account/export and
// /api/account/delete: Vercel's Hobby plan caps deployments at 12 functions.
const polar = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
  server: process.env.POLAR_SERVER ?? "production",
});

async function handleExport(req, res) {
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

async function handleDelete(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return res.status(401).json({ error: "unauthorized" });

  const { confirmEmail } = req.body || {};
  if (confirmEmail !== session.user.email) {
    return res.status(400).json({ error: "confirmEmail must match your account email" });
  }

  const authUserId = session.user.id;

  // Best-effort: cancel any active Polar subscription before deleting the account
  // that owns it. Deletion proceeds even if Polar is unreachable.
  try {
    const state = await polar.customers.getStateExternal({ externalId: authUserId });
    for (const sub of state.activeSubscriptions || []) {
      await polar.subscriptions.revoke({ id: sub.id });
    }
  } catch (err) {
    console.error("polar cancellation failed during account delete", authUserId, err);
  }

  // Deletes the earcue `users` row (traces, day_reviews, usage_daily cascade via
  // their own FKs), then the Better Auth `user` row (session/account/verification
  // cascade via theirs), atomically.
  await sql.transaction([
    sql`delete from users where auth_user_id = ${authUserId}`,
    sql`delete from "user" where id = ${authUserId}`,
  ]);

  res.setHeader("set-cookie", "better-auth.session_token=; Path=/; Max-Age=0");
  res.status(200).json({ deleted: true });
}

export default async function handler(req, res) {
  if (req.query.action === "export") return handleExport(req, res);
  if (req.query.action === "delete") return handleDelete(req, res);
  return res.status(404).json({ error: "not found" });
}
