import { requireUser } from "@/lib/server/auth";
import { assertEntitled } from "@/lib/server/entitlement";
import { env } from "@/lib/server/env";
import { chat } from "@/lib/server/llm";
import { consume } from "@/lib/server/quota";
import { json, readJson, withErrors } from "@/lib/server/respond";
import { MAX_CLAIM_CHARS, MAX_CONTEXT_CHARS } from "@/lib/shared/prompt";

export const POST = withErrors(async (request: Request) => {
  const user = await requireUser(request.headers);
  assertEntitled(user);

  const body = await readJson(request);
  const claim = String(body.claim || "").trim().slice(0, MAX_CLAIM_CHARS);
  if (!claim) return json({ error: "claim required" }, 400);
  const context = String(body.context || "").slice(0, MAX_CONTEXT_CHARS);

  await consume(user, "assist_calls", 1);

  const result = await chat({
    model: env.MODEL_REASON,
    messages: [
      {
        role: "user",
        content: `You have no web access. Judge the claim from general knowledge and answer UNVERIFIED whenever you cannot be sure. Verdict first: TRUE, FALSE, MISLEADING or UNVERIFIED, then one sentence.\n\nClaim: ${claim}\n\nContext: ${context}`,
      },
    ],
    maxTokens: 300,
    userId: user.id,
  });

  const text = result.text;
  const citations: { url: string }[] = [];

  return json({ text, citations });
});
