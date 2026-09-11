import { missingEnv, billingEnabled, googleAuthEnabled, connectorsEnabled } from "./_lib/env.js";

export default function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  const missing = missingEnv();
  const release = process.env.VERCEL_GIT_COMMIT_SHA || "dev";
  const authorized =
    (req.headers.authorization || "") === `Bearer ${process.env.CRON_SECRET || "\u0000"}`;
  res.status(missing.length === 0 ? 200 : 503).json({
    ok: missing.length === 0,
    release,
    missingCount: missing.length,
    features: {
      billing: billingEnabled(),
      googleAuth: googleAuthEnabled(),
      connectors: connectorsEnabled(),
    },
    ...(authorized ? { missing } : {}),
  });
}
