import { requireUser, Unauthorized } from "../_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    await requireUser(req);
  } catch (e) {
    if (e instanceof Unauthorized) return res.status(401).json({ error: "unauthorized" });
    throw e;
  }

  const now = Date.now();
  const body = {
    uses: 1,
    expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
    liveConnectConstraints: {
      model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
      config: { sessionResumption: {}, responseModalities: ["AUDIO"] },
    },
  };

  const res2 = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res2.ok) {
    const text = await res2.text();
    return res.status(502).json({ error: `auth_tokens ${res2.status}: ${text}` });
  }
  const json = await res2.json();
  res.status(200).json({ token: json.name });
}
