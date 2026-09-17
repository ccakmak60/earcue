import { requireUser } from "@/lib/server/auth";
import { assertEntitled } from "@/lib/server/entitlement";
import { env } from "@/lib/server/env";
import { chatJson, type JsonSchema } from "@/lib/server/llm";
import { consume } from "@/lib/server/quota";
import { json, readJson, withErrors } from "@/lib/server/respond";
import { clampPromptRows, MAX_RECENT_ROWS, serializeForPrompt } from "@/lib/shared/prompt";

const SCHEMA: JsonSchema = {
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
  "Emit an empty array when nothing qualifies — that is the common case.";

export const POST = withErrors(async (request: Request) => {
  const user = await requireUser(request.headers);
  assertEntitled(user);
  await consume(user, "watch_calls", 1);

  const { rows, recent } = await readJson(request);
  const payload = serializeForPrompt(clampPromptRows(rows), clampPromptRows(recent, MAX_RECENT_ROWS));

  const result = await chatJson({
    model: env.MODEL_REASON,
    messages: [{ role: "user", content: `${INSTRUCTION}\n\n${payload}` }],
    schema: SCHEMA,
    maxTokens: 600,
    deadlineMs: 25000,
  });

  return json(result);
});
