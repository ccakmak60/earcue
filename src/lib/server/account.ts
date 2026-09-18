import "server-only";
import { requireUser } from "./auth";
import { getAuth } from "./auth-server";
import { sql, withTransaction } from "./db";
import { isEntitled, polar } from "./entitlement";
import { env, billingEnabled } from "./env";
import { logError } from "./log";
import { capsFor } from "./plans";
import { localDay } from "./quota";
import { empty, json, readJson, withErrors } from "./respond";

// Actions behind /api/account/[action]. Each checks its own method and answers 405 with no body on a
// mismatch; the route answers 404 for an unknown action.

export const handleExport = withErrors(async (request: Request) => {
  if (request.method !== "GET") return empty(405);
  const user = await requireUser(request.headers);

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

  return json({ profile, traces, dayReviews, connections, contextItems, meetings, suggestions }, 200, {
    "content-disposition": `attachment; filename="earcue-export-${user.id}.json"`,
  });
});

export const handleUsage = withErrors(async (request: Request) => {
  if (request.method !== "GET") return empty(405);
  const user = await requireUser(request.headers);

  const day = localDay(user.tz);
  const [row] = await sql`
    select audio_seconds, frames, watch_calls, reviews, assist_calls, connector_syncs
    from usage_daily where user_id = ${user.id} and day = ${day}
  `;
  return json({
    day,
    plan: user.plan,
    entitled: isEntitled(user),
    unlimited: Boolean(user.unlimited),
    usage: row || { audio_seconds: 0, frames: 0, watch_calls: 0, reviews: 0, assist_calls: 0, connector_syncs: 0 },
    caps: capsFor(user),
  });
});

export async function handleDelete(request: Request): Promise<Response> {
  if (request.method !== "POST") return empty(405);

  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return json({ error: "unauthorized" }, 401);

  const { confirmEmail } = await readJson(request);
  if (confirmEmail !== session.user.email) {
    return json({ error: "confirmEmail must match your account email" }, 400);
  }

  const authUserId = session.user.id;

  // Best-effort: cancel any active Polar subscription before deleting the account
  // that owns it. Deletion proceeds even if Polar is unreachable.
  if (billingEnabled()) {
    try {
      const state = await polar().customers.getStateExternal({ externalId: authUserId });
      for (const sub of state.activeSubscriptions || []) {
        await polar().subscriptions.revoke({ id: sub.id });
      }
    } catch (err) {
      logError("polar_cancel_failed", err, { authUserId });
    }
  }

  // Deletes the earcue `users` row (traces, day_reviews, usage_daily cascade via
  // their own FKs), then the Better Auth `user` row (session/account/verification
  // cascade via theirs), atomically.
  await withTransaction(async (tx) => {
    await tx`delete from users where auth_user_id = ${authUserId}`;
    await tx`delete from "user" where id = ${authUserId}`;
  });

  return json({ deleted: true }, 200, { "set-cookie": "better-auth.session_token=; Path=/; Max-Age=0" });
}

// Own checkout endpoint, not the `checkout()` Better Auth plugin: that plugin's
// CheckoutParams schema forwards client-supplied allowTrial/trialInterval/
// trialIntervalCount straight through to Polar, letting a crafted request grant
// itself an arbitrarily long trial. This endpoint takes no body fields at all —
// the product id is fixed server-side and the trial length comes only from the
// Polar product's own configuration (see Phase C1: 7-day trial on the product).
export async function handleCheckout(request: Request): Promise<Response> {
  if (request.method !== "POST") return empty(405);
  if (!billingEnabled()) return json({ error: "billing_disabled" }, 503);

  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return json({ error: "unauthorized" }, 401);

  const checkout = await polar().checkouts.create({
    products: [env.POLAR_PRODUCT_ID_PRO],
    externalCustomerId: session.user.id,
    customerEmail: session.user.email,
    successUrl: `${env.BETTER_AUTH_URL}/app?checkout={CHECKOUT_ID}`,
  });

  return json({ url: checkout.url });
}
