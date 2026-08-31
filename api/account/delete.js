import { fromNodeHeaders } from "better-auth/node";
import { Polar } from "@polar-sh/sdk";
import { sql } from "../_lib/db.js";
import { auth } from "../_lib/auth-server.js";

const polar = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
  server: process.env.POLAR_SERVER ?? "production",
});

export default async function handler(req, res) {
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
