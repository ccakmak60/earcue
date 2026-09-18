import "server-only";

export type CapKey =
  | "audioSeconds"
  | "frames"
  | "watchCalls"
  | "reviews"
  | "assistCalls"
  | "connectorSyncs"
  | "importItems"
  | "distills"
  | "recalls";

export type PlanCaps = Record<CapKey, number>;

// Single tuning point for unit economics. Inference and embeddings both run on Azure OpenAI
// (src/lib/server/llm.ts, src/lib/server/embed.ts), which meters requests and tokens rather than
// publishing a per-token price; the authorized /api/health `llm` field reports today's actual
// consumption. Adjust these numbers together against that meter; the arithmetic, not the specific
// numbers, is the thing to preserve.
export const PLANS: Record<string, PlanCaps> = {
  none: { audioSeconds: 0, frames: 0, watchCalls: 0, reviews: 0, assistCalls: 0, connectorSyncs: 0, importItems: 0, distills: 0, recalls: 50 },
  pro: { audioSeconds: 8 * 3600, frames: 1440, watchCalls: 480, reviews: 2, assistCalls: 160, connectorSyncs: 96, importItems: 200000, distills: 24, recalls: 1000 },
};

// Billing off does NOT mean open season. Sign-up is public, and inference is billed to our Azure
// account, so an unrecognised account gets plan "none" (recalls only, assertEntitled fails) exactly
// as it would with billing on. Access without Polar comes from users.unlimited, set deliberately by
// `npm run seed:admin` or `npm run dev:seed`. The stored users.plan column is untouched either way,
// so turning billing on later restores real gating with no migration.
export function effectivePlan(plan: string | null | undefined): string {
  return plan || "none";
}

// Admin/test accounts. Not Infinity: JSON.stringify(Infinity) is `null`, and src/lib/shared/budget.ts
// planIntervals() reads a null cap as 0 and stops the capture loop outright. These numbers are
// large enough that consume() never throws and the client pacer always sits at its FLOOR_MS.
export const UNLIMITED_CAPS: PlanCaps = {
  audioSeconds: 86400,
  frames: 1000000,
  watchCalls: 1000000,
  reviews: 1000000,
  assistCalls: 1000000,
  connectorSyncs: 1000000,
  importItems: 100000000,
  distills: 1000000,
  recalls: 1000000,
};

export function capsFor(user: { plan: string; unlimited?: boolean | null }): PlanCaps {
  return user.unlimited ? UNLIMITED_CAPS : PLANS[user.plan] || PLANS.none;
}

export const PRICE_USD = 19;
