import { requireUser } from "@/lib/server/auth";
import { assertEntitled } from "@/lib/server/entitlement";
import { env } from "@/lib/server/env";
import { chat } from "@/lib/server/nim";
import { consume } from "@/lib/server/quota";
import { json, readJson, withErrors } from "@/lib/server/respond";

export const maxDuration = 60;

export const POST = withErrors(async (request: Request) => {
  const user = await requireUser(request.headers);
  assertEntitled(user);
  await consume(user, "assist_calls", 1);

  const { claim, context } = await readJson(request);
  if (!claim) return json({ error: "claim required" }, 400);

  const result = await chat({
    model: env.MODEL_REASON,
    messages: [
      {
        role: "user",
        content: `You have no web access. Judge the claim from general knowledge and answer UNVERIFIED whenever you cannot be sure. Verdict first: TRUE, FALSE, MISLEADING or UNVERIFIED, then one sentence.\n\nClaim: ${claim}\n\nContext: ${context || ""}`,
      },
    ],
    maxTokens: 300,
  });

  const text = result.text;
  const citations: { url: string }[] = [];

  return json({ text, citations });
});
