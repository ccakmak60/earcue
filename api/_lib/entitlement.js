import { Polar } from "@polar-sh/sdk";
import { sql } from "./db.js";
import { env, billingEnabled } from "./env.js";

export class PaymentRequired extends Error {
  constructor() {
    super("payment_required");
    this.status = 402;
  }
}

export function isEntitled(user) {
  return Boolean(user.unlimited) || user.plan === "pro";
}

export function assertEntitled(user) {
  if (!isEntitled(user)) throw new PaymentRequired();
}

let polarClient = null;
function polar() {
  if (!polarClient) {
    polarClient = new Polar({ accessToken: env.POLAR_ACCESS_TOKEN, server: env.POLAR_SERVER });
  }
  return polarClient;
}

function externalIdFromPayload(payload) {
  const data = payload?.data;
  return data?.externalId ?? data?.customer?.externalId ?? null;
}

// Sole writer of users.plan/plan_status/current_period_end. Called from the Polar
// webhook plugin on customer-state changes and paid orders. Re-fetches the
// canonical customer state from Polar by external id rather than trusting the
// webhook payload's own shape (which differs between event types), so gating
// never depends on a live call to Polar on the request path, only here.
export async function syncEntitlement(payload) {
  if (!billingEnabled()) return;
  const externalId = externalIdFromPayload(payload);
  if (!externalId) return;

  const state = await polar().customers.getStateExternal({ externalId });
  const active = (state.activeSubscriptions || []).find((s) => s.status === "active" || s.status === "trialing");

  const plan = active ? "pro" : "none";
  const planStatus = active ? active.status : null;
  const currentPeriodEnd = active ? active.currentPeriodEnd ?? null : null;

  await sql`
    update users
    set plan = ${plan}, plan_status = ${planStatus}, current_period_end = ${currentPeriodEnd}
    where auth_user_id = ${externalId}
  `;
}
