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

export const PRICE_USD = 19;
