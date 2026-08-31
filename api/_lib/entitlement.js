import { Polar } from "@polar-sh/sdk";
import { sql } from "./db.js";

export class PaymentRequired extends Error {
  constructor() {
    super("payment_required");
    this.status = 402;
  }
}

export function assertEntitled(user) {
  if (user.plan !== "pro") throw new PaymentRequired();
}

const polar = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN,
  server: process.env.POLAR_SERVER ?? "production",
});

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
  const externalId = externalIdFromPayload(payload);
  if (!externalId) return;

  const state = await polar.customers.getStateExternal({ externalId });
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
