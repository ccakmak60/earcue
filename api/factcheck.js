import { requireUser, Unauthorized } from "./_lib/auth.js";
import { chat } from "./_lib/nim.js";
import { env } from "./_lib/env.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    await requireUser(req);
  } catch (e) {
    if (e instanceof Unauthorized) return res.status(401).json({ error: "unauthorized" });
    throw e;
  }

  const { claim, context } = req.body || {};
  if (!claim) return res.status(400).json({ error: "claim required" });

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
  const citations = [];

  res.status(200).json({ text, citations });
}
