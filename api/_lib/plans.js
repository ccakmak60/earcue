import { billingEnabled } from "./env.js";

// Single tuning point for unit economics. Re-verify current published Gemini
// rates for gemini-3.5-transcribe, gemini-3.5-flash-lite, gemini-3.7-flash,
// and gemini-2.5-flash-native-audio-preview-12-2025 before launch and adjust
// these numbers together; the arithmetic, not the specific numbers, is the
// thing to preserve.
export const PLANS = {
  none: { audioSeconds: 0, frames: 0, watchCalls: 0, reviews: 0, assistCalls: 0, connectorSyncs: 0, importItems: 0, distills: 0, recalls: 50 },
  pro: { audioSeconds: 8 * 3600, frames: 1440, watchCalls: 480, reviews: 2, assistCalls: 160, connectorSyncs: 96, importItems: 200000, distills: 24, recalls: 1000 },
};

// With billing off the product runs as a single-tier app: every signed-in user gets Pro caps and
// passes assertEntitled(). The stored users.plan column is untouched, so turning billing on later
// restores real gating with no migration.
export function effectivePlan(plan) {
  return billingEnabled() ? plan || "none" : "pro";
}

// Admin/test accounts. Not Infinity: JSON.stringify(Infinity) is `null`, and src/budget.js
// planIntervals() reads a null cap as 0 and stops the capture loop outright. These numbers are
// large enough that consume() never throws and the client pacer always sits at its FLOOR_MS.
export const UNLIMITED_CAPS = {
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

export function capsFor(user) {
  return user.unlimited ? UNLIMITED_CAPS : PLANS[user.plan] || PLANS.none;
}

export const PRICE_USD = 19;
