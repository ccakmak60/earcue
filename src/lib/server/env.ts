import "server-only";

export const REQUIRED_ENV = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "CRON_SECRET",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_BASE_URL",
] as const;

export const ENV_DEFAULTS = {
  POLAR_SERVER: "production",
  MODEL_TRANSCRIBE: "earcue-transcribe",
  MODEL_VISION: "earcue-vision",
  MODEL_REASON: "earcue-reason",
  DAILY_TOKEN_CEILING: "0", // 0 = off; a day's total Azure OpenAI tokens across all users
  REVIEW_LOCAL_HOUR: "22", // a day is reviewed once the user's own clock passes this hour
  SWEEP_LIMIT: "200",
  SWEEP_BUDGET_MS: "50000",
  CONTEXT_RETENTION_DAYS: "30",
  MODEL_EMBED: "earcue-embed",
  IMPORT_LOOKBACK_DAYS: "180",
  DISTILL_BATCH: "300",
  // Both thresholds are fitted to earcue-embed (text-embedding-3-small at 768 dims, re-normalized by
  // embed.ts), measured 2026-09-18 on labelled pairs shaped like memories.text: paraphrases of one
  // fact scored 0.63–0.89, two different facts about the same subject topped out at 0.62, a recall
  // query against the memory it should return scored 0.22–0.55, and against an unrelated memory
  // 0.00–0.18. gemini-embedding-001's old values (0.9 / 0.35) missed every duplicate and dropped
  // 4 of 10 true recalls on that set. Dedup sits well above the different-fact band because a wrong
  // merge loses a fact permanently while a missed one only costs a duplicate row. The recall bands
  // overlap at 0.18–0.22, and the floor only picks RRF candidates that memory_strength then
  // demotes, so it errs generous rather than dropping a real recall. Re-measure on real memories.
  MEMORY_DEDUP_SIM: "0.72",
  RECALL_CANDIDATES: "30",
  RECALL_MIN_SIM: "0.15",
  RECALL_RRF_K: "60",
  MEMORY_FORGET_FLOOR: "0.05",
  DREAM_MIN_MEMORIES: "12",
  EPISODE_GAP_MS: "900000",
  HEALTH_STALE_BROWSER_HOURS: "48",
  HEALTH_STALE_BOOKMARKS_HOURS: "192",
  HEALTH_STALE_WHATSAPP_HOURS: "48",
  HEALTH_STALE_DISTILL_HOURS: "36",
  HEALTH_STALE_IMPORT_MINUTES: "60",
  PAGE_TRACE_MS: "60000",
  DISTILL_PAGE_CHARS: "1500",
  DISTILL_PAGE_ITEMS: "40",
  HEALTH_STALE_PAGES_HOURS: "48",
  CONNECTOR_ENC_KEY: "",
  TURNSTILE_SECRET_KEY: "",
  TURNSTILE_SITE_KEY: "",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  SLACK_CLIENT_ID: "",
  SLACK_CLIENT_SECRET: "",
  WAHA_BASE_URL: "",
  WAHA_API_KEY: "",
  WAHA_WEBHOOK_BASE_URL: "",
  BILLING_ENABLED: "0",
  POLAR_ACCESS_TOKEN: "",
  POLAR_WEBHOOK_SECRET: "",
  POLAR_PRODUCT_ID_PRO: "",
} as const;

type EnvName = (typeof REQUIRED_ENV)[number] | keyof typeof ENV_DEFAULTS;

export function missingEnv(): string[] {
  return REQUIRED_ENV.filter((name) => !process.env[name]);
}

// Billing is opt-in by explicit flag rather than presence-detected: a stale, real-shaped but revoked
// POLAR_ACCESS_TOKEN can linger in .env.local, and a half-configured Polar is worse than none — the
// plugin's createCustomerOnSignUp hook turns a Polar 401 into a 500 on /api/auth/sign-up/email.
// Flip to BILLING_ENABLED=1 only once all three Polar vars are real.
export function billingEnabled(): boolean {
  return (
    process.env.BILLING_ENABLED === "1" &&
    Boolean(process.env.POLAR_ACCESS_TOKEN) &&
    Boolean(process.env.POLAR_WEBHOOK_SECRET) &&
    Boolean(process.env.POLAR_PRODUCT_ID_PRO)
  );
}

// Turnstile guards public sign-up. Both halves must be present: the secret verifies server-side and
// the site key renders the widget, and a widget with no verification is decoration.
export function turnstileEnabled(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY && process.env.TURNSTILE_SITE_KEY);
}

// Google vars are simply absent (no placeholder trap), so presence is enough: adding real
// credentials re-enables the sign-in button with no code change.
export function googleAuthEnabled(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export interface ConnectorFlags {
  google: boolean;
  slack: boolean;
  whatsapp: boolean;
}

// Data connectors additionally need the token-encryption key (src/lib/server/secretbox.ts).
export function connectorsEnabled(): ConnectorFlags {
  const key = Boolean(process.env.CONNECTOR_ENC_KEY);
  return {
    google: key && googleAuthEnabled(),
    slack: key && Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET),
    whatsapp: key && Boolean(process.env.WAHA_BASE_URL && process.env.WAHA_API_KEY),
  };
}

const descriptors: PropertyDescriptorMap = {};
for (const name of REQUIRED_ENV) {
  descriptors[name] = {
    enumerable: true,
    get() {
      const value = process.env[name];
      if (!value) throw new Error(`missing required env: ${name}`);
      return value;
    },
  };
}
for (const [name, fallback] of Object.entries(ENV_DEFAULTS)) {
  descriptors[name] = {
    enumerable: true,
    get() {
      return process.env[name] || fallback;
    },
  };
}

// Required vars throw lazily, on first property access, never at import time.
export const env = Object.freeze(Object.defineProperties({}, descriptors)) as Readonly<Record<EnvName, string>>;
