import { requireUser, Unauthorized } from "../_lib/auth.js";
import { assertEntitled, PaymentRequired } from "../_lib/entitlement.js";
import { consume, QuotaExceeded } from "../_lib/quota.js";
import { chatJson } from "../_lib/nim.js";
import { env } from "../_lib/env.js";

const SCHEMA = {
  type: "object",
  properties: {
    app: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    activity: { type: "string" },
    salient_text: { type: "string" },
    sensitive: { type: "boolean" },
  },
  required: ["app", "activity", "sensitive"],
};

const INSTRUCTION =
  "This is one sampled frame of a user's screen. Describe what they are doing in one sentence (activity), " +
  "name the foreground app or site (app) and the exact window, tab, or page title (title), and when a browser address bar is visible " +
  "copy the URL it shows into url (origin and path are enough; keep query strings only when they carry meaning). Copy the most " +
  "decision-relevant on-screen strings into salient_text (\u2264600 chars) \u2014 prefer headings, names, figures, dates, and the text the user " +
  "is reading or writing, verbatim. Set sensitive true if a password field, banking page, medical record, or private message thread is visible.";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof Unauthorized) return res.status(401).json({ error: "unauthorized" });
    throw e;
  }
  try {
    assertEntitled(user);
  } catch (e) {
    if (e instanceof PaymentRequired) return res.status(402).json({ error: "payment_required" });
    throw e;
  }

  const { frames } = req.body || {};
  if (!Array.isArray(frames) || frames.length === 0) {
    return res.status(400).json({ error: "frames required" });
  }
  if (frames.some((f) => typeof f.dataB64 !== "string" || f.dataB64.length > 2_000_000)) {
    return res.status(400).json({ error: "frame too large" });
  }

  const sliced = frames.slice(0, 1);
  try {
    await consume(user, "frames", sliced.length);
  } catch (e) {
    if (e instanceof QuotaExceeded) return res.status(429).json({ error: "quota", metric: e.metric });
    throw e;
  }

  const result = await chatJson({
    model: env.MODEL_VISION,
    messages: [{ role: "user", content: [
      { type: "text", text: INSTRUCTION },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${sliced[0].dataB64}` } },
    ] }],
    schema: SCHEMA,
    maxTokens: 500,
    deadlineMs: 45000,
  });
  res.status(200).json(result);
}
