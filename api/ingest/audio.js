import { requireUser, Unauthorized } from "../_lib/auth.js";
import { callInteraction, outputText, wordAnnotations } from "../_lib/gemini.js";
import { groupTurns } from "../../src/turns.js";

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    await requireUser(req);
  } catch (e) {
    if (e instanceof Unauthorized) return res.status(401).json({ error: "unauthorized" });
    throw e;
  }

  const source = req.query.source === "system" ? "system" : "mic";
  const startedAt = Number(req.query.startedAt) || 0;
  const durationMs = Number(req.query.durationMs) || 60000;

  const audioBuf = await readRawBody(req);
  const dataB64 = audioBuf.toString("base64");

  const interaction = await callInteraction({
    model: "gemini-3.5-transcribe",
    store: false,
    input: [{ type: "audio", data: dataB64, mime_type: "audio/webm" }],
    generation_config: {
      transcription_config: {
        language_codes: [],
        mode: { type: "verbatim", diarization_mode: "speaker", timestamp_granularities: ["word"] },
      },
    },
  });

  const text = outputText(interaction);
  if (!text) return res.status(200).json({ turns: [], source, startedAt, durationMs });

  const words = wordAnnotations(interaction);
  const turns = groupTurns(words, durationMs, text);

  res.status(200).json({ turns, source, startedAt, durationMs });
}
