export const REQUIRED_ENV = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "CRON_SECRET",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
];

export const ENV_DEFAULTS = {
  POLAR_SERVER: "production",
  NIM_BASE_URL: "https://integrate.api.nvidia.com/v1",
  GEMINI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta",
  MODEL_TRANSCRIBE: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  MODEL_VISION: "meta/llama-3.2-11b-vision-instruct",
  MODEL_REASON: "minimaxai/minimax-m3",
  SWEEP_LIMIT: "200",
  SWEEP_BUDGET_MS: "50000",
  CONTEXT_RETENTION_DAYS: "30",
  ASSIST_MIN_INTERVAL_MS: "180000",
  MODEL_EMBED: "gemini-embedding-001",
  IMPORT_LOOKBACK_DAYS: "180",
  DISTILL_BATCH: "300",
  MEMORY_DEDUP_SIM: "0.9",
  RECALL_CANDIDATES: "30",
  RECALL_RRF_K: "60",
  MEMORY_FORGET_FLOOR: "0.05",
  DREAM_MIN_MEMORIES: "12",
  EPISODE_GAP_MS: "900000",
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
};

export function missingEnv() {
  return REQUIRED_ENV.filter((name) => !process.env[name]);
}

// Billing is opt-in by explicit flag rather than presence-detected: `vercel env pull` leaves a
// real-shaped but revoked POLAR_ACCESS_TOKEN in .env.local, and a half-configured Polar is worse
// than none — the plugin's createCustomerOnSignUp hook turns a Polar 401 into a 500 on
// /api/auth/sign-up/email. Flip to BILLING_ENABLED=1 only once all three Polar vars are real.
export function billingEnabled() {
  return (
    process.env.BILLING_ENABLED === "1" &&
    Boolean(process.env.POLAR_ACCESS_TOKEN) &&
    Boolean(process.env.POLAR_WEBHOOK_SECRET) &&
    Boolean(process.env.POLAR_PRODUCT_ID_PRO)
  );
}

// Google vars are simply absent (no placeholder trap), so presence is enough: adding real
// credentials re-enables the sign-in button with no code change.
export function googleAuthEnabled() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// Data connectors additionally need the token-encryption key (api/_lib/secretbox.js).
export function connectorsEnabled() {
  const key = Boolean(process.env.CONNECTOR_ENC_KEY);
  return {
    google: key && googleAuthEnabled(),
    slack: key && Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET),
    whatsapp: key && Boolean(process.env.WAHA_BASE_URL && process.env.WAHA_API_KEY),
  };
}

const descriptors = {};
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

export const env = Object.freeze(Object.defineProperties({}, descriptors));
