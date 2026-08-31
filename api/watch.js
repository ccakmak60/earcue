import { requireUser, Unauthorized } from "./_lib/auth.js";
import { consume, QuotaExceeded } from "./_lib/quota.js";
import { callInteraction, parseJsonOutput } from "./_lib/gemini.js";

const SCHEMA = {
  type: "object",
  properties: {
    flags: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["factcheck", "commitment", "contradiction", "nudge"] },
          claim: { type: "string" },
          why: { type: "string" },
          urgency: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["type", "claim", "why", "urgency"],
      },
    },
  },
  required: ["flags"],
};

const INSTRUCTION =
  "You are watching one minute of a user's day. Emit a flag only when it is worth interrupting a working person: " +
  "factcheck for a checkable factual claim someone just asserted, commitment for a promise the user made, " +
  "contradiction when the user contradicted something earlier in `recent`, nudge when the screen and speech show the user stuck or drifting. " +
  "Emit an empty array when nothing qualifies \u2014 that is the common case.";

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
    await consume(user, "watch_calls", 1);
  } catch (e) {
    if (e instanceof QuotaExceeded) return res.status(429).json({ error: "quota", metric: e.metric });
    throw e;
  }

  const { rows, recent } = req.body || {};
  const payload = { rows: rows || [], recent: recent || [] };

  const interaction = await callInteraction({
    model: "gemini-3.7-flash",
    store: false,
    input: [{ type: "text", text: `${INSTRUCTION}\n\n${JSON.stringify(payload)}` }],
    response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
  });

  const result = parseJsonOutput(interaction);
  res.status(200).json(result);
}
