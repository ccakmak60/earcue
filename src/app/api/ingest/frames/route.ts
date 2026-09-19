import { requireUser } from "@/lib/server/auth";
import { assertEntitled } from "@/lib/server/entitlement";
import { env } from "@/lib/server/env";
import { chatJson, type JsonSchema } from "@/lib/server/llm";
import { consume } from "@/lib/server/quota";
import { json, readJson, withErrors } from "@/lib/server/respond";

const SCHEMA: JsonSchema = {
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
  "decision-relevant on-screen strings into salient_text (≤600 chars) — prefer headings, names, figures, dates, and the text the user " +
  "is reading or writing, verbatim. Set sensitive true if a password field, banking page, medical record, or private message thread is visible.";

export const POST = withErrors(async (request: Request) => {
  const user = await requireUser(request.headers);
  assertEntitled(user);

  const { frames } = await readJson(request);
  if (!Array.isArray(frames) || frames.length === 0) {
    return json({ error: "frames required" }, 400);
  }
  if (frames.some((f: { dataB64?: unknown }) => typeof f.dataB64 !== "string" || f.dataB64.length > 2_000_000)) {
    return json({ error: "frame too large" }, 400);
  }

  const sliced = frames.slice(0, 1) as { dataB64: string }[];
  await consume(user, "frames", sliced.length);

  const result = await chatJson({
    model: env.MODEL_VISION,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: INSTRUCTION },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${sliced[0].dataB64}` } },
        ],
      },
    ],
    schema: SCHEMA,
    maxTokens: 500,
    deadlineMs: 45000,
    userId: user.id,
  });
  return json(result);
});
