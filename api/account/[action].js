import { fromNodeHeaders } from "better-auth/node";
import { Polar } from "@polar-sh/sdk";
import { sql } from "../_lib/db.js";
import { requireUser, hashKey, Unauthorized } from "../_lib/auth.js";
import { auth } from "../_lib/auth-server.js";
import { env } from "../_lib/env.js";
import { logError } from "../_lib/log.js";
import { PLANS } from "../_lib/plans.js";

// Single serverless function serving /api/account/export, /api/account/delete,
// /api/account/usage, /api/account/checkout, and /api/account/device-claim:
// Vercel's Hobby plan caps deployments at 12 functions.
const polar = new Polar({
  accessToken: env.POLAR_ACCESS_TOKEN,
  server: env.POLAR_SERVER,
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
  const connections = await sql`
    select provider, account_label, scope, last_synced_at
    from connections where user_id = ${user.id} order by provider asc
  `;
  const contextItems = await sql`
    select provider, external_id, ts, kind, title, body, url, meta
    from context_items where user_id = ${user.id} order by ts asc
  `;
  const meetings = await sql`
    select client_id, started_at, ended_at, local_day, source, title, notes, notes_status, error
    from meetings where user_id = ${user.id} order by started_at asc
  `;
  const suggestions = await sql`
    select client_id, ts, local_day, kind, title, detail, draft_text, evidence, urgency, confidence, status
    from suggestions where user_id = ${user.id} order by ts asc
  `;

  res.setHeader("content-disposition", `attachment; filename="earcue-export-${user.id}.json"`);
  res.status(200).json({ profile, traces, dayReviews, connections, contextItems, meetings, suggestions });
}

async function handleUsage(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof Unauthorized) return res.status(401).json({ error: "unauthorized" });
    throw e;
  }

  const day = new Intl.DateTimeFormat("en-CA", { timeZone: user.tz || "UTC" }).format(new Date());
  const [row] = await sql`
    select audio_seconds, frames, watch_calls, reviews, live_seconds, assist_calls, connector_syncs
    from usage_daily where user_id = ${user.id} and day = ${day}
  `;
  res.status(200).json({
    day,
    plan: user.plan,
    usage: row || { audio_seconds: 0, frames: 0, watch_calls: 0, reviews: 0, live_seconds: 0, assist_calls: 0, connector_syncs: 0 },
    caps: PLANS[user.plan] || PLANS.none,
  });
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
    logError("polar_cancel_failed", err, { authUserId });
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

// Own checkout endpoint, not the `checkout()` Better Auth plugin: that plugin's
// CheckoutParams schema forwards client-supplied allowTrial/trialInterval/
// trialIntervalCount straight through to Polar, letting a crafted request grant
// itself an arbitrarily long trial. This endpoint takes no body fields at all —
// the product id is fixed server-side and the trial length comes only from the
// Polar product's own configuration (see Phase C1: 7-day trial on the product).
async function handleCheckout(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return res.status(401).json({ error: "unauthorized" });

  const checkout = await polar.checkouts.create({
    products: [env.POLAR_PRODUCT_ID_PRO],
    externalCustomerId: session.user.id,
    customerEmail: session.user.email,
    successUrl: `${env.BETTER_AUTH_URL}/app?checkout={CHECKOUT_ID}`,
  });

  res.status(200).json({ url: checkout.url });
}

async function handleDeviceClaim(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return res.status(401).json({ error: "unauthorized" });

  const { deviceKey } = req.body || {};
  if (!deviceKey) return res.status(400).json({ error: "deviceKey required" });

  const hash = hashKey(deviceKey);
  const authUserId = session.user.id;

  const [deviceRow] = await sql`select id, auth_user_id from users where device_key_hash = ${hash}`;
  if (!deviceRow || deviceRow.auth_user_id !== null) {
    return res.status(200).json({ claimed: false });
  }

  const [sessionRow] = await sql`select id from users where auth_user_id = ${authUserId}`;
  if (!sessionRow) {
    // No prior session row: just attach the device row to this account.
    await sql`update users set auth_user_id = ${authUserId} where id = ${deviceRow.id}`;
    return res.status(200).json({ claimed: true, movedTraces: 0 });
  }

  // Session already had its own (empty) row: move the device row's data onto it, then delete the
  // device row, atomically so a mid-move failure can never orphan traces.
  const [movedTraces] = await sql.transaction([
    sql`update traces set user_id = ${sessionRow.id} where user_id = ${deviceRow.id} returning id`,
    sql`update day_reviews set user_id = ${sessionRow.id}
        where user_id = ${deviceRow.id}
          and not exists (select 1 from day_reviews d2 where d2.user_id = ${sessionRow.id} and d2.day = day_reviews.day)`,
    sql`delete from day_reviews where user_id = ${deviceRow.id}`,
    sql`delete from usage_daily where user_id = ${deviceRow.id}`,
    sql`delete from users where id = ${deviceRow.id}`,
  ]);

  return res.status(200).json({ claimed: true, movedTraces: movedTraces.length });
}

export default async function handler(req, res) {
  if (req.query.action === "export") return handleExport(req, res);
  if (req.query.action === "delete") return handleDelete(req, res);
  if (req.query.action === "usage") return handleUsage(req, res);
  if (req.query.action === "checkout") return handleCheckout(req, res);
  if (req.query.action === "device-claim") return handleDeviceClaim(req, res);
  return res.status(404).json({ error: "not found" });
}
