import { requireUser, Unauthorized } from "./_lib/auth.js";
import { callInteraction, outputText, urlCitations } from "./_lib/gemini.js";

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

  const interaction = await callInteraction({
    model: "gemini-3.7-flash",
    store: false,
    tools: [{ type: "google_search" }],
    input: [
      {
        type: "text",
        text: `Verdict first: TRUE, FALSE, MISLEADING or UNVERIFIED, then one sentence.\n\nClaim: ${claim}\n\nContext: ${context || ""}`,
      },
    ],
  });

  const text = outputText(interaction);
  const citations = urlCitations(interaction).map((c) => ({
    url: c.url,
    title: c.title,
    startIndex: c.start_index,
    endIndex: c.end_index,
  }));

  res.status(200).json({ text, citations });
}
