export const REQUIRED_ENV = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "CRON_SECRET",
  "GEMINI_API_KEY",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
  "POLAR_PRODUCT_ID_PRO",
  "CONNECTOR_ENC_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
];

export const ENV_DEFAULTS = {
  POLAR_SERVER: "production",
  GEMINI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta",
  GEMINI_LIVE_WS_URL:
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
  MODEL_TRANSCRIBE: "gemini-3.5-transcribe",
  MODEL_VISION: "gemini-3.5-flash-lite",
  MODEL_REASON: "gemini-3.7-flash",
  MODEL_LIVE: "models/gemini-2.5-flash-native-audio-preview-12-2025",
  SWEEP_LIMIT: "200",
  SWEEP_BUDGET_MS: "50000",
  CONTEXT_RETENTION_DAYS: "30",
  ASSIST_MIN_INTERVAL_MS: "180000",
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
