// Single tuning point for unit economics. Re-verify current published Gemini
// rates for gemini-3.5-transcribe, gemini-3.5-flash-lite, gemini-3.7-flash,
// and gemini-2.5-flash-native-audio-preview-12-2025 before launch and adjust
// these numbers together; the arithmetic, not the specific numbers, is the
// thing to preserve.
export const PLANS = {
  none: { audioSeconds: 0, frames: 0, watchCalls: 0, reviews: 0, liveSeconds: 0 },
  pro: { audioSeconds: 4 * 3600, frames: 360, watchCalls: 200, reviews: 2, liveSeconds: 3600 },
};

export const PRICE_USD = 19;
