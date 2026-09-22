// Product switches that are compile-time constants rather than env vars: flipping one changes which
// views and settings the /app shell renders, not how any endpoint behaves.

// Browser mic/screen capture (All day, Day and Assist views, capture settings, flag toasts) is on hold
// while the product focuses on imports and recommendations. The capture code and its endpoints stay
// intact; set this to true to bring the views back.
export const CAPTURE_ENABLED = false;
