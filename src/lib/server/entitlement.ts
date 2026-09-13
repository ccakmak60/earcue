import "server-only";
import { Polar } from "@polar-sh/sdk";
import { sql } from "./db";
import { env, billingEnabled } from "./env";
import { PaymentRequired } from "./errors";

export function isEntitled(user: { plan: string; unlimited?: boolean | null }): boolean {
  return Boolean(user.unlimited) || user.plan === "pro";
}

export function assertEntitled(user: { plan: string; unlimited?: boolean | null }): void {
  if (!isEntitled(user)) throw new PaymentRequired();
}

let polarClient: Polar | null = null;
export function polar(): Polar {
  if (!polarClient) {
    polarClient = new Polar({ accessToken: env.POLAR_ACCESS_TOKEN, server: env.POLAR_SERVER as "production" | "sandbox" });
  }
  return polarClient;
}

interface WebhookPayload {
  data?: { externalId?: string | null; customer?: { externalId?: string | null } };
}

function externalIdFromPayload(payload: unknown): string | null {
  const data = (payload as WebhookPayload | null)?.data;
  return data?.externalId ?? data?.customer?.externalId ?? null;
}

// Sole writer of users.plan/plan_status/current_period_end. Called from the Polar
// webhook plugin on customer-state changes and paid orders. Re-fetches the
// canonical customer state from Polar by external id rather than trusting the
// webhook payload's own shape (which differs between event types), so gating
// never depends on a live call to Polar on the request path, only here.
export async function syncEntitlement(payload: unknown): Promise<void> {
  if (!billingEnabled()) return;
  const externalId = externalIdFromPayload(payload);
  if (!externalId) return;

  const state = await polar().customers.getStateExternal({ externalId });
  const active = (state.activeSubscriptions || []).find((s) => s.status === "active" || s.status === "trialing");

  const plan = active ? "pro" : "none";
  const planStatus = active ? active.status : null;
  const currentPeriodEnd = active ? (active.currentPeriodEnd ?? null) : null;

  await sql`
    update users
    set plan = ${plan}, plan_status = ${planStatus}, current_period_end = ${currentPeriodEnd}
    where auth_user_id = ${externalId}
  `;
}
