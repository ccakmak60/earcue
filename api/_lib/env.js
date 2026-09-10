export const REQUIRED_ENV = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "CRON_SECRET",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
  "POLAR_PRODUCT_ID_PRO",
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
};

export function missingEnv() {
  return REQUIRED_ENV.filter((name) => !process.env[name]);
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
