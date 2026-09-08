import { requireUser, Unauthorized } from "../_lib/auth.js";
import { assertEntitled, PaymentRequired } from "../_lib/entitlement.js";
import { consume, QuotaExceeded } from "../_lib/quota.js";
import { chat, EmptyCompletion } from "../_lib/nim.js";
import { groupTurns } from "../../src/turns.js";
import { env } from "../_lib/env.js";

export const config = { api: { bodyParser: false } };

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

class PayloadTooLarge extends Error {}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_AUDIO_BYTES) {
        req.destroy();
        reject(new PayloadTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

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

  const source = ["system", "import"].includes(req.query.source) ? req.query.source : "mic";
  const startedAt = Number(req.query.startedAt) || 0;
  const durationMs = Number(req.query.durationMs) || 60000;

  try {
    await consume(user, "audio_seconds", Math.round(durationMs / 1000));
  } catch (e) {
    if (e instanceof QuotaExceeded) return res.status(429).json({ error: "quota", metric: e.metric });
    throw e;
  }

  let audioBuf;
  try {
    audioBuf = await readRawBody(req);
  } catch (e) {
    if (e instanceof PayloadTooLarge) return res.status(413).json({ error: "audio chunk too large" });
    throw e;
  }
  const dataB64 = audioBuf.toString("base64");

  // NIM rejects codec parameters in the data URI (audio/webm;codecs=opus -> 500); MIME_ALLOW keeps this bare.
  const MIME_ALLOW = ["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/ogg"];
  const mime = MIME_ALLOW.includes(req.query.mime) ? req.query.mime : "audio/webm";

  const ASR_SYSTEM =
    "You are a speech-to-text engine. Output only the verbatim transcript of the audio. " +
    "Never explain, never reason, never comment. If there is no speech, output nothing.";

  let text;
  try {
    const result = await chat({
      model: env.MODEL_TRANSCRIBE,
      messages: [
        { role: "system", content: ASR_SYSTEM },
        { role: "user", content: [
          { type: "text", text: "Transcribe the speech verbatim. Output only the transcript text, nothing else." },
          { type: "audio_url", audio_url: { url: `data:${mime};base64,${dataB64}` } },
        ] },
      ],
      maxTokens: 1200,
      deadlineMs: 45000,
    });
    text = result.text.trim();
  } catch (e) {
    if (e instanceof EmptyCompletion) return res.status(200).json({ turns: [], source, startedAt, durationMs });
    throw e;
  }
  if (!text) return res.status(200).json({ turns: [], source, startedAt, durationMs });

  const turns = groupTurns([], durationMs, text);

  res.status(200).json({ turns, source, startedAt, durationMs });
}
