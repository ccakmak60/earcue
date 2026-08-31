import { requireUser, Unauthorized } from "../_lib/auth.js";
import { callInteraction, parseJsonOutput } from "../_lib/gemini.js";

const SCHEMA = {
  type: "object",
  properties: {
    app: { type: "string" },
    title: { type: "string" },
    activity: { type: "string" },
    salient_text: { type: "string" },
    changed: { type: "boolean" },
    sensitive: { type: "boolean" },
  },
  required: ["app", "activity", "changed", "sensitive"],
};

const INSTRUCTION =
  "These frames are consecutive samples of one minute of a user's screen. Describe what they were doing in one sentence (activity), " +
  "name the foreground app or site (app) and window/page title (title), copy the few most decision-relevant on-screen strings into " +
  "salient_text (\u2264200 chars), set changed false if the minute was a single static view, and set sensitive true if a password field, " +
  "banking page, medical record, or private message thread is visible.";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    await requireUser(req);
  } catch (e) {
    if (e instanceof Unauthorized) return res.status(401).json({ error: "unauthorized" });
    throw e;
  }

  const { frames } = req.body || {};
  if (!Array.isArray(frames) || frames.length === 0) {
    return res.status(400).json({ error: "frames required" });
  }

  const input = [{ type: "text", text: INSTRUCTION }];
  for (const f of frames.slice(0, 6)) {
    input.push({ type: "image", data: f.dataB64, mime_type: "image/jpeg", resolution: "medium" });
  }

  const interaction = await callInteraction({
    model: "gemini-3.5-flash-lite",
    store: false,
    input,
    response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
  });

  const result = parseJsonOutput(interaction);
  res.status(200).json(result);
}
