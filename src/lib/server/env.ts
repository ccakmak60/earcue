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
  SWEEP_LIMIT: "200",
  SWEEP_BUDGET_MS: "50000",
  CONTEXT_RETENTION_DAYS: "30",
  MODEL_EMBED: "earcue-embed",
  IMPORT_LOOKBACK_DAYS: "180",
  DISTILL_BATCH: "300",
  MEMORY_DEDUP_SIM: "0.9",
  RECALL_CANDIDATES: "30",
  RECALL_MIN_SIM: "0.35",
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
