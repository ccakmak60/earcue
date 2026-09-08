// Single tuning point for unit economics. Re-verify current published Gemini
// rates for gemini-3.5-transcribe, gemini-3.5-flash-lite, gemini-3.7-flash,
// and gemini-2.5-flash-native-audio-preview-12-2025 before launch and adjust
// these numbers together; the arithmetic, not the specific numbers, is the
// thing to preserve.
export const PLANS = {
  none: { audioSeconds: 0, frames: 0, watchCalls: 0, reviews: 0, assistCalls: 0, connectorSyncs: 0, importItems: 0, distills: 0 },
  pro: { audioSeconds: 8 * 3600, frames: 1440, watchCalls: 480, reviews: 2, assistCalls: 160, connectorSyncs: 96, importItems: 200000, distills: 24 },
};

export const PRICE_USD = 19;
